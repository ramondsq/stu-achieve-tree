# Pet Assets

本目录用于存放宠物图鉴的本地帧素材源文件。

当前约定：

- 每只宠物 4 种状态：
  - `hungry`
  - `gloomy`
  - `happy`
  - `super_happy`
- 每个状态使用独立帧序列目录
- 文件名统一三位数，例如：
  - `001.png`
  - `002.png`
  - `003.png`
- 建议尺寸统一为 `512x512`
- 建议背景透明
- 建议优先完成 `happy/`，因为选宠列表预览默认使用开心状态帧

当前图鉴宠物：

- `starlight_cat`
- `nebula_dog`
- `comet_rabbit`
- `aurora_fox`

示例结构：

```text
pet-assets/
  starlight_cat/
    hungry/
      001.png
    gloomy/
    happy/
    super_happy/
```
