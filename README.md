# photo-restyle

把照片重绘成某种风格：上传一张照片，Agent 从 94 种风格里推荐合适的（或用你指定的），自动拉取这个风格作者的 Skill，再用 Agent 自己的生图能力画出来。不用自己找、自己装。

```
npx skills add MuziGeek/photo-restyle
```

装好后直接对 Agent 说：「把这张照片画成水彩明信片」或者「这张照片适合什么风格？帮我画一张」。

## 有哪些风格

海报与版式、绘画与插画、水墨与国风、立体与材质、拼贴与手帐、卡片与档案、光色与氛围、抽象与超现实，共 94 种，都收录自 GitHub 上公开的照片重绘 Skill。

## 它怎么工作

1. Agent 看照片，挑风格（`node scripts/hub.mjs list` / `search`）。
2. `node scripts/hub.mjs fetch <风格>` 从作者仓库拉取最新版本，只下 Skill 运行要用的文件，存在 `~/.cache/photo-style-hub/`；一小时内用过的直接读缓存。
3. Agent 按作者的 SKILL.md 绘制，交付时附上作者和许可。

需要 Node 18+。本 Skill 不生图、不上传照片，只从 GitHub / jsDelivr 下载作者公开的文件。

## 版权

- 本仓库的脚本和说明按 MIT 许可（见 [LICENSE](LICENSE)）。
- 拉取的各个风格 Skill 版权归各自作者，按作者自己的许可使用；没有许可文件的仓库，作者保留所有权利，仅供个人使用。
- 作者如果不希望自己的 Skill 被收录，提 Issue 即可移除。

## 可选设置

| 环境变量 | 作用 |
| --- | --- |
| `STYLE_HUB_RAW` | 访问不了 GitHub 和 jsDelivr 时，填 raw.githubusercontent 格式的镜像前缀 |
| `GITHUB_TOKEN` | 提高 GitHub API 限额（不带时每小时 60 次，正常使用够用） |
| `STYLE_HUB_CACHE` | 缓存目录 |
| `STYLE_HUB_FRESH_MINUTES` | 缓存多久内不检查更新，默认 60 |

`index.json` 由「照片重绘样张」站点仓库生成，不要手改。
