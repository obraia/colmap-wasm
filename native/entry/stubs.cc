// Replacements for parts excluded from the wasm build.
// - Bitmap without OpenImageIO: in-memory pixels only (the entries decode
//   images outside); Read() fails, so the mapper extracts no point colours.
// - ONNX matchers and LoMa (need onnxruntime/OpenImageIO): option checks only;
//   creating them fails.
// - FeatureDescriptorIndex without faiss: not available; the SIFT matcher is
//   configured with cpu_brute_force_matcher, which does not use it.
#include "colmap/feature/index.h"
#include "colmap/feature/loma.h"
#include "colmap/feature/onnx_matchers.h"
#include "colmap/sensor/bitmap.h"
#include "colmap/util/logging.h"

namespace colmap {

Bitmap::Bitmap() : width_(0), height_(0), channels_(0), linear_colorspace_(false) {}

Bitmap::Bitmap(const int width, const int height, const bool as_rgb, const bool linear_colorspace)
    : width_(width), height_(height), channels_(as_rgb ? 3 : 1), linear_colorspace_(linear_colorspace) {
  data_.resize(static_cast<size_t>(width_) * height_ * channels_);
}

Bitmap::Bitmap(const Bitmap& other)
    : width_(other.width_), height_(other.height_), channels_(other.channels_),
      linear_colorspace_(other.linear_colorspace_), data_(other.data_) {}

Bitmap::Bitmap(Bitmap&& other) noexcept
    : width_(other.width_), height_(other.height_), channels_(other.channels_),
      linear_colorspace_(other.linear_colorspace_), data_(std::move(other.data_)),
      meta_data_(std::move(other.meta_data_)) {
  other.width_ = other.height_ = other.channels_ = 0;
}

Bitmap& Bitmap::operator=(const Bitmap& other) {
  if (this != &other) {
    width_ = other.width_;
    height_ = other.height_;
    channels_ = other.channels_;
    linear_colorspace_ = other.linear_colorspace_;
    data_ = other.data_;
    meta_data_.reset();
  }
  return *this;
}

Bitmap& Bitmap::operator=(Bitmap&& other) noexcept {
  if (this != &other) {
    width_ = other.width_;
    height_ = other.height_;
    channels_ = other.channels_;
    linear_colorspace_ = other.linear_colorspace_;
    data_ = std::move(other.data_);
    meta_data_ = std::move(other.meta_data_);
    other.width_ = other.height_ = other.channels_ = 0;
  }
  return *this;
}

bool Bitmap::Read(const std::filesystem::path&, bool, bool) { return false; }

Bitmap Bitmap::Clone() const { return *this; }

// Same weights and rounding as sensor/bitmap.cc.
Bitmap Bitmap::CloneAsGrey() const {
  if (IsGrey()) return Clone();
  Bitmap cloned(width_, height_, /*as_rgb=*/false, linear_colorspace_);
  for (size_t i = 0; i < cloned.data_.size(); ++i) {
    // NOLINTNEXTLINE(bugprone-incorrect-roundings)
    cloned.data_[i] = static_cast<uint8_t>(.2126f * data_[3 * i + 0] + .7152f * data_[3 * i + 1] +
                                           .0722f * data_[3 * i + 2] + .5f);
  }
  return cloned;
}

std::unique_ptr<FeatureDescriptorIndex> FeatureDescriptorIndex::Create(Type, int) {
  LOG(FATAL) << "FeatureDescriptorIndex (faiss) is not available in the wasm build";
  return nullptr;
}

bool BruteForceONNXMatchingOptions::Check() const { return true; }
bool LightGlueONNXMatchingOptions::Check() const { return true; }
bool LomaExtractionOptions::Check() const { return true; }
bool LomaMatchingOptions::Check() const { return true; }

std::unique_ptr<FeatureMatcher> CreateBruteForceONNXFeatureMatcher(const FeatureMatchingOptions&,
                                                                   const BruteForceONNXMatchingOptions&,
                                                                   std::vector<FeatureExtractorType>, bool) {
  LOG(FATAL) << "ONNX matchers are not available in the wasm build";
  return nullptr;
}
std::unique_ptr<FeatureMatcher> CreateLightGlueONNXFeatureMatcher(const FeatureMatchingOptions&,
                                                                  const LightGlueONNXMatchingOptions&) {
  LOG(FATAL) << "ONNX matchers are not available in the wasm build";
  return nullptr;
}
std::unique_ptr<FeatureExtractor> CreateLomaFeatureExtractor(const FeatureExtractionOptions&) {
  LOG(FATAL) << "LoMa is not available in the wasm build";
  return nullptr;
}
std::unique_ptr<FeatureMatcher> CreateLomaFeatureMatcher(const FeatureMatchingOptions&) {
  LOG(FATAL) << "LoMa is not available in the wasm build";
  return nullptr;
}

}  // namespace colmap
