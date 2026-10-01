# Third-party notices

Runtime and development packages are installed from npm under their respective licenses. The production runtime uses:

- Three.js — MIT

Development tooling:

- Vite — MIT
- TypeScript — Apache-2.0
- Vitest — MIT

The offline sprite pipeline (`scripts/cutout_fighters.py`, not part of the shipped game) uses [rembg](https://github.com/danielgatis/rembg) — MIT — with the IS-Net general-use segmentation model, plus Pillow, NumPy and SciPy.

Typefaces are served by Google Fonts: Cinzel and Manrope — SIL Open Font License 1.1.

The exact package versions and transitive dependency metadata are recorded in `package-lock.json`.
