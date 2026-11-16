# 第三方代码归属

本仓库的 MIT 许可（见 `LICENSE`）覆盖本项目自有代码。下面这些第三方组件按各自的许可分发，版权归原作者。

---

## dsh-video-coursemap

- **位置**：`app/vendor/dsh-video-coursemap/`
- **作者**：dsh-video-coursemap contributors
- **来源**：https://github.com/linner1224/dsh-video-coursemap
- **版本**：2.0.0
- **许可**：MIT
- **用途**：课程助手的核心引擎——轮询前台窗口标题、识别 B 站课程视频、抓取弹幕/评论/字幕、调用 LLM 生成知识总结、把 Markdown 转成 Word。
- **改动情况**：原样内置，未修改任何源码。完整许可全文见 `app/vendor/dsh-video-coursemap/LICENSE`。

内置而非通过 `npm install` 获取的原因：这个插件本来是给 DeepSeek Harness 用的，本应用只借用它的 `apply()` 与工具定义，因此直接随仓库分发，保证 clone 下来就能用，不依赖用户是否装过 DSH。

其 `scripts/md2docx.py` 同一来源、同一许可。

---

## 依赖说明

本项目其余部分**零第三方依赖**：

- 后端只用 Node.js 标准库（`node:http`、`node:fs`、`node:child_process` 等），无 `package-lock.json`、无 `node_modules`。
- 前端不用框架、不用构建工具、不加载任何 CDN 资源，`public/` 下就是最终产物。
- 转 Word 依赖 Python 的 `python-docx`（MIT），但它运行在用户自己的 Python 环境里，不作为本仓库的一部分分发。
