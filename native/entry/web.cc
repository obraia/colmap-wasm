// Browser entry (src/worker.ts): a C API over COLMAP's CPU SIFT extraction and
// the geometric verification + view-graph calibration + global mapper
// pipeline, on an in-memory database. Matching happens outside (WebGPU,
// src/sift-matcher.ts). Single-threaded; results stay valid until the next
// call of the same group.
#include "colmap/controllers/global_pipeline.h"
#include "colmap/estimators/two_view_geometry.h"
#include "colmap/estimators/view_graph_calibration.h"
#include "colmap/feature/extractor.h"
#include "colmap/feature/sift.h"
#include "colmap/math/random.h"
#include "colmap/scene/database.h"
#include "colmap/scene/reconstruction_manager.h"
#include "colmap/sensor/bitmap.h"
#include "colmap/util/logging.h"
#include "colmap/util/timer.h"

#include <emscripten/emscripten.h>

#include <cstdio>
#include <unordered_map>

using namespace colmap;

namespace {

std::string g_error;

template <typename F>
int Guard(F&& f) {
  try {
    return f();
  } catch (const std::exception& e) {
    g_error = e.what();
    std::fprintf(stderr, "error: %s\n", e.what());
    return -1;
  }
}

void InitLogging() {
  static bool done = false;
  if (done) return;
  google::InitGoogleLogging("colmap");
  FLAGS_logtostderr = true;
  done = true;
}

// --- extraction
std::unique_ptr<FeatureExtractor> g_extractor;
std::vector<float> g_keypoints;  // n × 6: x, y, a11, a12, a21, a22
FeatureDescriptors g_descriptors;

// --- mapping
std::shared_ptr<Database> g_db;
Camera g_camera;
rig_t g_rig_id = kInvalidRigId;
std::vector<image_t> g_image_ids;  // by input index
std::vector<double> g_poses;       // by input index: registered, R (row-major), t
std::vector<double> g_points;      // x, y, z, error
std::vector<int32_t> g_tracks;     // per point: length, then (input index, keypoint) pairs
double g_camera_params[3];

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* cw_error() { return g_error.c_str(); }

/** SIFT (COLMAP defaults, CPU) on an RGB image. Returns the number of features. */
EMSCRIPTEN_KEEPALIVE int cw_extract(const uint8_t* rgb, int width, int height) {
  return Guard([&] {
    InitLogging();
    if (!g_extractor) {
      FeatureExtractionOptions options(FeatureExtractorType::SIFT);
      options.use_gpu = false;
      options.num_threads = 1;
      g_extractor = FeatureExtractor::Create(options);
      THROW_CHECK_NOTNULL(g_extractor);
    }
    Bitmap bitmap(width, height, /*as_rgb=*/true);
    std::copy(rgb, rgb + static_cast<size_t>(width) * height * 3, bitmap.RowMajorData().begin());
    const Bitmap grey = bitmap.CloneAsGrey();
    FeatureKeypoints keypoints;
    THROW_CHECK(g_extractor->Extract(grey, &keypoints, &g_descriptors));
    g_keypoints.resize(keypoints.size() * 6);
    for (size_t i = 0; i < keypoints.size(); ++i) {
      const FeatureKeypoint& k = keypoints[i];
      const float v[6] = {k.x, k.y, k.a11, k.a12, k.a21, k.a22};
      std::copy(v, v + 6, g_keypoints.begin() + 6 * i);
    }
    return static_cast<int>(keypoints.size());
  });
}

EMSCRIPTEN_KEEPALIVE const float* cw_keypoints() { return g_keypoints.data(); }
EMSCRIPTEN_KEEPALIVE const uint8_t* cw_descriptors() { return g_descriptors.data.data(); }

/** New in-memory database with one SIMPLE_PINHOLE camera (focal 1.2 × max side,
 *  as `colmap feature_extractor`). */
EMSCRIPTEN_KEEPALIVE int cw_map_begin(int width, int height) {
  return Guard([&] {
    InitLogging();
    g_db = Database::Open(":memory:");
    g_camera = Camera::CreateFromModelName(kInvalidCameraId, "SIMPLE_PINHOLE",
                                           1.2 * std::max(width, height), width, height);
    g_camera.camera_id = g_db->WriteCamera(g_camera);
    Rig rig;
    rig.AddRefSensor(g_camera.SensorId());
    g_rig_id = g_db->WriteRig(rig);
    g_image_ids.clear();
    return 0;
  });
}

/** Adds the next image (input index = call order) with its keypoints (n × 6). */
EMSCRIPTEN_KEEPALIVE int cw_map_image(const char* name, const float* keypoints, int n) {
  return Guard([&] {
    Image image;
    image.SetName(name);
    image.SetCameraId(g_camera.camera_id);
    image.SetImageId(g_db->WriteImage(image));
    Frame frame;
    frame.SetRigId(g_rig_id);
    frame.AddDataId(image.DataId());
    g_db->WriteFrame(frame);
    FeatureKeypoints kps(n);
    for (int i = 0; i < n; ++i) {
      const float* k = keypoints + 6 * i;
      kps[i] = FeatureKeypoint(k[0], k[1], k[2], k[3], k[4], k[5]);
    }
    g_db->WriteKeypoints(image.ImageId(), kps);
    g_image_ids.push_back(image.ImageId());
    return static_cast<int>(g_image_ids.size()) - 1;
  });
}

/** Raw matches between input images a and b (n pairs of keypoint indices). */
EMSCRIPTEN_KEEPALIVE int cw_map_matches(int a, int b, const uint32_t* matches, int n) {
  return Guard([&] {
    FeatureMatches m(n);
    for (int i = 0; i < n; ++i) {
      m[i].point2D_idx1 = matches[2 * i];
      m[i].point2D_idx2 = matches[2 * i + 1];
    }
    g_db->WriteMatches(g_image_ids.at(a), g_image_ids.at(b), m);
    return 0;
  });
}

/** Geometric verification, view-graph calibration and the global mapper, all
 *  seeded with `seed`. Returns the number of registered images. */
EMSCRIPTEN_KEEPALIVE int cw_map_run(int seed) {
  return Guard([&] {
    SetPRNGSeed(seed);
    Timer timer;
    timer.Start();
    // `colmap geometric_verifier` on every matched pair
    TwoViewGeometryOptions geometry;
    geometry.ransac_options.random_seed = seed;
    std::unordered_map<image_t, std::vector<Eigen::Vector2d>> points;
    for (const image_t id : g_image_ids) {
      const FeatureKeypoints kps = g_db->ReadKeypoints(id);
      auto& p = points[id];
      p.resize(kps.size());
      for (size_t i = 0; i < kps.size(); ++i) p[i] = {kps[i].x, kps[i].y};
    }
    {
      DatabaseTransaction transaction(g_db.get());
      for (auto& [pair_id, matches] : g_db->ReadAllMatches()) {
        const auto [id1, id2] = PairIdToImagePair(pair_id);
        TwoViewGeometry tvg;
        if (matches.size() < static_cast<size_t>(geometry.min_num_inliers)) {
          tvg.config = TwoViewGeometry::DEGENERATE;
        } else {
          tvg = EstimateTwoViewGeometry(g_camera, points[id1], g_camera, points[id2], matches, geometry);
        }
        if (tvg.config == TwoViewGeometry::UNDEFINED) continue;
        if (tvg.config == TwoViewGeometry::DEGENERATE ||
            tvg.inlier_matches.size() < static_cast<size_t>(geometry.min_num_inliers)) {
          tvg = TwoViewGeometry();
          tvg.config = TwoViewGeometry::DEGENERATE;
        }
        g_db->WriteTwoViewGeometry(id1, id2, tvg);
      }
    }
    std::fprintf(stderr, "[colmap] geometric verification in %.1f s\n", timer.ElapsedSeconds());
    // `colmap view_graph_calibrator`, seeded (natively it is not)
    timer.Restart();
    ViewGraphCalibrationOptions calibration;
    calibration.random_seed = seed;
    if (!CalibrateViewGraph(calibration, g_db.get())) {
      std::fprintf(stderr, "[colmap] view graph calibration failed, continuing without it\n");
    }
    std::fprintf(stderr, "[colmap] view graph calibration in %.1f s\n", timer.ElapsedSeconds());
    // `colmap global_mapper`
    timer.Restart();
    GlobalPipelineOptions options;
    options.num_threads = 1;
    options.random_seed = seed;
    auto manager = std::make_shared<ReconstructionManager>();
    GlobalPipeline(options, g_db, manager).Run();
    std::fprintf(stderr, "[colmap] global mapper in %.1f s\n", timer.ElapsedSeconds());

    g_poses.assign(g_image_ids.size() * 13, 0);
    g_points.clear();
    g_tracks.clear();
    if (manager->Size() == 0) return 0;
    const auto rec = manager->Get(0);
    std::unordered_map<image_t, int> index;
    for (size_t i = 0; i < g_image_ids.size(); ++i) index[g_image_ids[i]] = static_cast<int>(i);
    const Camera& cam = rec->Cameras().begin()->second;
    g_camera_params[0] = cam.MeanFocalLength();
    g_camera_params[1] = cam.PrincipalPointX();
    g_camera_params[2] = cam.PrincipalPointY();
    int registered = 0;
    for (const image_t id : rec->RegImageIds()) {
      const Image& image = rec->Image(id);
      const Rigid3d pose = image.CamFromWorld();
      const Eigen::Matrix3d R = pose.rotation().toRotationMatrix();
      double* out = &g_poses[13 * index.at(id)];
      out[0] = 1;
      for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c) out[1 + 3 * r + c] = R(r, c);
      for (int k = 0; k < 3; ++k) out[10 + k] = pose.translation()(k);
      ++registered;
    }
    for (const auto& [point_id, point] : rec->Points3D()) {
      g_points.insert(g_points.end(), {point.xyz(0), point.xyz(1), point.xyz(2), point.error});
      g_tracks.push_back(static_cast<int32_t>(point.track.Length()));
      for (const auto& el : point.track.Elements()) {
        g_tracks.push_back(index.at(el.image_id));
        g_tracks.push_back(static_cast<int32_t>(el.point2D_idx));
      }
    }
    return registered;
  });
}

EMSCRIPTEN_KEEPALIVE const double* cw_res_camera() { return g_camera_params; }
EMSCRIPTEN_KEEPALIVE const double* cw_res_poses() { return g_poses.data(); }
EMSCRIPTEN_KEEPALIVE int cw_res_num_points() { return static_cast<int>(g_points.size() / 4); }
EMSCRIPTEN_KEEPALIVE const double* cw_res_points() { return g_points.data(); }
EMSCRIPTEN_KEEPALIVE int cw_res_tracks_size() { return static_cast<int>(g_tracks.size()); }
EMSCRIPTEN_KEEPALIVE const int32_t* cw_res_tracks() { return g_tracks.data(); }

/** Frees the database and results. */
EMSCRIPTEN_KEEPALIVE void cw_map_end() {
  g_db.reset();
  std::vector<double>().swap(g_poses);
  std::vector<double>().swap(g_points);
  std::vector<int32_t>().swap(g_tracks);
}

}  // extern "C"
