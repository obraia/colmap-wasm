// colmap-wasm PoC, SIFT stage: <image list> <raw dir> <mask dir or -> <pairs.txt> <new database>
// Same as `colmap feature_extractor` (CPU SIFT, single SIMPLE_PINHOLE camera, masks)
// + `colmap matches_importer --match_type pairs` (CPU brute-force SIFT matching) without
// the geometric verification, which colmap_gm runs.
// Images are raw files written by tools/raw.py: int32 width, height, channels + bytes
// (decoded outside so the wasm needs no image codecs).
#include "colmap/feature/extractor.h"
#include "colmap/feature/matcher.h"
#include "colmap/feature/sift.h"
#include "colmap/scene/database.h"
#include "colmap/sensor/bitmap.h"
#include "colmap/util/logging.h"
#include "colmap/util/timer.h"

#include <cstdio>
#include <fstream>
#include <map>
#include <string>

using namespace colmap;

static bool ReadRaw(const std::string& path, Bitmap* bitmap) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return false;
  int32_t hdr[3];
  f.read(reinterpret_cast<char*>(hdr), sizeof(hdr));
  *bitmap = Bitmap(hdr[0], hdr[1], /*as_rgb=*/hdr[2] == 3);
  f.read(reinterpret_cast<char*>(bitmap->RowMajorData().data()), bitmap->NumBytes());
  return static_cast<bool>(f);
}

// Same as MaskFeatures in controllers/feature_extraction.cc.
static void MaskFeatures(const Bitmap& mask, FeatureKeypoints* keypoints, FeatureDescriptors* descriptors) {
  size_t out = 0;
  for (size_t i = 0; i < keypoints->size(); ++i) {
    const auto color = mask.GetPixel(static_cast<int>(keypoints->at(i).x), static_cast<int>(keypoints->at(i).y));
    if (!color || color->r == 0) continue;
    if (out != i) {
      keypoints->at(out) = keypoints->at(i);
      descriptors->data.row(out) = descriptors->data.row(i);
    }
    ++out;
  }
  keypoints->resize(out);
  descriptors->data.conservativeResize(out, descriptors->data.cols());
}

static std::string Stem(const std::string& name) { return name.substr(0, name.rfind('.')); }

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
  if (argc < 6) {
    std::fprintf(stderr, "usage: %s <image list> <raw dir> <mask dir|-> <pairs.txt> <new database>\n", argv[0]);
    return 2;
  }
  google::InitGoogleLogging(argv[0]);
  FLAGS_logtostderr = true;
  const std::string raw_dir = argv[2], mask_dir = argv[3];
  std::vector<std::string> names;
  {
    std::ifstream f(argv[1]);
    for (std::string n; std::getline(f, n);)
      if (!n.empty()) names.push_back(n);
  }
  auto database = Database::Open(argv[5]);

  // --- extraction
  Timer timer;
  timer.Start();
  FeatureExtractionOptions eopts(FeatureExtractorType::SIFT);
  eopts.use_gpu = false;
  eopts.num_threads = 1;
  auto extractor = FeatureExtractor::Create(eopts);
  THROW_CHECK_NOTNULL(extractor);
  Camera camera;
  Rig rig;
  std::map<std::string, image_t> ids;
  std::map<image_t, std::shared_ptr<FeatureKeypoints>> keypoints;
  std::map<image_t, std::shared_ptr<FeatureDescriptors>> descriptors;
  size_t total = 0;
  for (const std::string& name : names) {
    Bitmap rgb;
    THROW_CHECK(ReadRaw(raw_dir + "/" + Stem(name) + ".raw", &rgb)) << name;
    if (camera.camera_id == kInvalidCameraId) {
      camera = Camera::CreateFromModelName(kInvalidCameraId, "SIMPLE_PINHOLE",
                                           1.2 * std::max(rgb.Width(), rgb.Height()),
                                           rgb.Width(), rgb.Height());
      camera.camera_id = database->WriteCamera(camera);
      rig.AddRefSensor(camera.SensorId());
      rig.SetRigId(database->WriteRig(rig));
    }
    const Bitmap grey = rgb.CloneAsGrey();
    auto kps = std::make_shared<FeatureKeypoints>();
    auto descs = std::make_shared<FeatureDescriptors>();
    THROW_CHECK(extractor->Extract(grey, kps.get(), descs.get())) << name;
    if (mask_dir != "-") {
      Bitmap mask;
      THROW_CHECK(ReadRaw(mask_dir + "/" + Stem(name) + ".raw", &mask)) << name;
      MaskFeatures(mask, kps.get(), descs.get());
    }
    Image image;
    image.SetName(name);
    image.SetCameraId(camera.camera_id);
    image.SetImageId(database->WriteImage(image));
    Frame frame;
    frame.SetRigId(rig.RigId());
    frame.AddDataId(image.DataId());
    database->WriteFrame(frame);
    database->WriteKeypoints(image.ImageId(), *kps);
    database->WriteDescriptors(image.ImageId(), *descs);
    ids[name] = image.ImageId();
    keypoints[image.ImageId()] = kps;
    descriptors[image.ImageId()] = descs;
    total += kps->size();
  }
  std::fprintf(stderr, "[wasm] extraction: %zu images, %zu features in %.2f s\n", names.size(), total,
               timer.ElapsedSeconds());

  // --- matching of the listed pairs
  timer.Restart();
  FeatureMatchingOptions mopts(FeatureMatcherType::SIFT_BRUTEFORCE);
  mopts.use_gpu = false;
  mopts.num_threads = 1;
  mopts.sift->cpu_brute_force_matcher = true;
  auto matcher = FeatureMatcher::Create(mopts);
  THROW_CHECK_NOTNULL(matcher);
  size_t pairs = 0, matched = 0;
  {
    std::ifstream f(argv[4]);
    DatabaseTransaction transaction(database.get());
    for (std::string a, b; f >> a >> b;) {
      FeatureMatcher::Image im1, im2;
      im1.image_id = ids.at(a);
      im2.image_id = ids.at(b);
      im1.camera = im2.camera = &camera;
      im1.keypoints = keypoints[im1.image_id];
      im2.keypoints = keypoints[im2.image_id];
      im1.descriptors = descriptors[im1.image_id];
      im2.descriptors = descriptors[im2.image_id];
      FeatureMatches matches;
      matcher->Match(im1, im2, &matches);
      database->WriteMatches(im1.image_id, im2.image_id, matches);
      ++pairs;
      matched += matches.size();
    }
  }
  std::fprintf(stderr, "[wasm] matching: %zu pairs, %zu matches in %.2f s\n", pairs, matched,
               timer.ElapsedSeconds());
  return 0;
}
