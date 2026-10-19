// colmap-wasm PoC entry: <database> <output dir> [seed] [calibrate]
// Same as `colmap geometric_verifier` (existing pairs) + `colmap global_mapper`
// with num_threads = 1 and a fixed seed, so it can be compared with a native run.
#include "colmap/controllers/global_pipeline.h"
#include "colmap/estimators/two_view_geometry.h"
#include "colmap/estimators/view_graph_calibration.h"
#include "colmap/feature/types.h"
#include "colmap/math/random.h"
#include "colmap/scene/database.h"
#include "colmap/scene/reconstruction_manager.h"
#include "colmap/util/logging.h"
#include "colmap/util/timer.h"

#include <cstdio>
#include <unordered_map>

using namespace colmap;

static std::vector<Eigen::Vector2d> Points(const FeatureKeypoints& kps) {
  std::vector<Eigen::Vector2d> p(kps.size());
  for (size_t i = 0; i < kps.size(); ++i) p[i] = {kps[i].x, kps[i].y};
  return p;
}

static int Run(int argc, char** argv);

// Exceptions reach JS as an opaque CppException; print them here instead.
int main(int argc, char** argv) {
  try {
    return Run(argc, argv);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "[wasm] error: %s\n", e.what());
    return 1;
  }
}

static int Run(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: %s <database> <output dir> [seed]\n", argv[0]);
    return 2;
  }
  google::InitGoogleLogging(argv[0]);
  FLAGS_logtostderr = true;
  const int seed = argc > 3 ? std::atoi(argv[3]) : 0;
  SetPRNGSeed(seed);

  auto database = Database::Open(argv[1]);

  // --- geometric verification of every pair that has matches
  Timer timer;
  timer.Start();
  TwoViewGeometryOptions geometry;
  geometry.ransac_options.random_seed = seed;
  std::unordered_map<camera_t, Camera> cameras;
  for (auto& c : database->ReadAllCameras()) cameras.emplace(c.camera_id, c);
  std::unordered_map<image_t, camera_t> image_camera;
  std::unordered_map<image_t, std::vector<Eigen::Vector2d>> points;
  for (auto& im : database->ReadAllImages()) {
    image_camera[im.ImageId()] = im.CameraId();
    points[im.ImageId()] = Points(database->ReadKeypoints(im.ImageId()));
  }
  database->ClearTwoViewGeometries();
  size_t verified = 0, degenerate = 0;
  {
    DatabaseTransaction transaction(database.get());
    for (auto& [pair_id, matches] : database->ReadAllMatches()) {
      const auto [id1, id2] = PairIdToImagePair(pair_id);
      TwoViewGeometry tvg;
      if (matches.size() < static_cast<size_t>(geometry.min_num_inliers)) {
        tvg.config = TwoViewGeometry::DEGENERATE;
      } else {
        tvg = EstimateTwoViewGeometry(cameras.at(image_camera[id1]), points[id1],
                                      cameras.at(image_camera[id2]), points[id2],
                                      matches, geometry);
      }
      if (tvg.config == TwoViewGeometry::UNDEFINED) continue;
      if (tvg.config == TwoViewGeometry::DEGENERATE ||
          tvg.inlier_matches.size() < static_cast<size_t>(geometry.min_num_inliers)) {
        tvg = TwoViewGeometry();
        tvg.config = TwoViewGeometry::DEGENERATE;
        ++degenerate;
      } else {
        ++verified;
      }
      database->WriteTwoViewGeometry(id1, id2, tvg);
    }
  }
  std::fprintf(stderr, "[wasm] verification: %zu verified, %zu degenerate in %.2f s\n",
               verified, degenerate, timer.ElapsedSeconds());

  // --- `colmap view_graph_calibrator` (default options), as the old desktop pipeline did
  if (argc > 4 && std::string(argv[4]) == "calibrate") {
    timer.Restart();
    ViewGraphCalibrationOptions calibration;
    calibration.random_seed = seed;  // native runs it unseeded
    THROW_CHECK(CalibrateViewGraph(calibration, database.get()));
    std::fprintf(stderr, "[wasm] view graph calibration in %.2f s\n", timer.ElapsedSeconds());
  }

  // --- global mapper
  timer.Restart();
  GlobalPipelineOptions options;
  options.num_threads = 1;
  options.random_seed = seed;
  auto manager = std::make_shared<ReconstructionManager>();
  GlobalPipeline pipeline(options, database, manager);
  pipeline.Run();
  std::fprintf(stderr, "[wasm] global mapper: %zu model(s) in %.2f s\n", manager->Size(),
               timer.ElapsedSeconds());
  if (manager->Size() == 0) return 1;
  auto rec = manager->Get(0);
  std::fprintf(stderr, "[wasm] model 0: %zu images, %zu points\n", rec->NumRegImages(),
               rec->NumPoints3D());
  rec->WriteBinary(argv[2]);
  return 0;
}
