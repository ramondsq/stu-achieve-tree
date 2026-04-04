# Pet Animated Assets

本目录存放小程序运行时直接读取的宠物状态动图资源。

约定：

- 每只宠物 4 个 animated WebP 文件
- 文件名固定为：
  - `hungry.webp`
  - `gloomy.webp`
  - `happy.webp`
  - `super_happy.webp`
- 路径示例：
  - `/assets/pets/starlight_cat/happy.webp`
  - `/assets/pets/nebula_dog/gloomy.webp`

当前代码会优先读取这里的 animated WebP。
如果某个状态没有动图，才会退回旧的帧序列方案。
