# Asset pipeline

`build_assets.py` regenerates every image in `public/` that is derived from the local design originals in
`design-references/` (which are git-ignored and never modified).

```bash
# from the repository root
python3 scripts/assets/build_assets.py                     # overwrite public/ assets
python3 scripts/assets/build_assets.py --out-root /tmp/x   # write elsewhere to compare first
```

Requirements: Python 3 with Pillow and NumPy, plus the `cwebp` CLI (`brew install webp`).

Use a NumPy release that officially supports your Python version. NumPy 1.26 on Python 3.14 was observed to
miscompute the logo cut-out; the script detects this via a round-trip check and aborts instead of writing wrong
assets. The committed assets were verified to be reproduced pixel-identically with Python 3.9 / NumPy 1.26 /
Pillow 10 and cwebp.

| Output                                 | Source         | Notes                                                        |
| -------------------------------------- | -------------- | ------------------------------------------------------------ |
| `public/images/logo-wordmark.webp`     | logo           | Transparent cut-out, sun + wordmark crop, 360 px wide        |
| `public/images/hero-synthwave.webp`    | background     | Native 941×1672                                              |
| `public/images/hero-synthwave-640.webp`| background     | 640 px wide, used below 768 px viewport width                |
| `public/images/og-image.jpg`           | both           | 1200×630 social preview                                      |
| `public/favicon.{ico,png}`, `public/apple-touch-icon.png` | logo | Original square logo incl. background          |

## Logo cut-out

The original logo sits on an almost uniform background (`rgb(7, 7, 31)`). A colour-to-alpha decomposition splits
every pixel into foreground colour and opacity, so the neon glow and the original colours are preserved; composited
back onto the original background colour it reproduces the source (mean deviation ≈ 1.4 / 255). Faint JPEG noise in
the near-transparent range is suppressed. The crop for header/footer keeps sun and wordmark; decorative lines cut by
the crop fade out over 24 px instead of ending abruptly.
