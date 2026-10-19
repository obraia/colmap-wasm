# raw.py <image dir> <out dir> [grey]: decode images (Pillow) into the raw format colmap_sift reads:
# int32 width, height, channels, then row-major uint8 pixels (RGB, or grey with "grey" for masks).
import os, sys
import numpy as np
from PIL import Image

src, out = sys.argv[1:3]
grey = len(sys.argv) > 3 and sys.argv[3] == "grey"
os.makedirs(out, exist_ok=True)
for name in sorted(os.listdir(src)):
    if name.startswith("."): continue
    im = Image.open(os.path.join(src, name)).convert("L" if grey else "RGB")
    a = np.asarray(im, dtype=np.uint8)
    with open(os.path.join(out, os.path.splitext(name)[0] + ".raw"), "wb") as f:
        f.write(np.array([im.width, im.height, 1 if grey else 3], np.int32).tobytes())
        f.write(np.ascontiguousarray(a).tobytes())
print("ok", out)
