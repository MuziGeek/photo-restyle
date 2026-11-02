#!/usr/bin/env node
// 照片重绘风格 Hub：列出风格、按名字或关键词查，并把选中风格作者的 Skill 拉到本机（作者仓库的最新版本）。
// 不上传任何东西，不生图。只依赖 Node 18+。
//
//   node hub.mjs list                 全部风格，一行一个
//   node hub.mjs search <关键词...>   按名称、简介、类别、标签查
//   node hub.mjs show <slug>          一个风格的完整条目
//   node hub.mjs fetch <slug>         拉取最新版本，打印本地 SKILL.md 路径
//
// 只下载 Skill 目录里运行要用的文件（跳过作者的示例图、截图、文档、测试），不下整个仓库。
//
// 环境变量：STYLE_HUB_INDEX 在线索引地址（不设就用随包的 index.json）
//           STYLE_HUB_RAW   文件下载前缀（raw.githubusercontent 格式的镜像）；不设时先走 jsDelivr，再走 raw.githubusercontent
//           STYLE_HUB_CACHE 缓存目录，默认 ~/.cache/photo-style-hub
//           STYLE_HUB_FRESH_MINUTES 缓存多久内不检查更新，默认 60
//           GITHUB_TOKEN    可选，提高 GitHub API 限额（不带时每小时 60 次，每次检查更新用 1–2 次；超限时用缓存或只取 SKILL.md）
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = (process.env.STYLE_HUB_API || "https://api.github.com").replace(/\/$/, "");
const RAW = (process.env.STYLE_HUB_RAW || "https://raw.githubusercontent.com").replace(/\/$/, "");
const CACHE = process.env.STYLE_HUB_CACHE || path.join(homedir(), ".cache", "photo-style-hub");

// 不是运行需要的：作者的示例、截图、文档、测试、隐藏目录
const SKIP = /(^|\/)(examples?|samples?|showcase|gallery|screenshots?|demos?|docs|tests?|__pycache__|node_modules|\.[^/]+)(\/|$)|(^|\/)README[^/]*$/i;
const VIDEO = /\.(mp4|mov|webm|gif|psd)$/i;
const IMAGE = /\.(png|jpe?g|webp|avif|bmp|tiff?)$/i;
const TEXT = /\.(md|txt|ya?ml|json|toml|py|m?js|cjs|ts|sh|ps1|html?|css|svg|csv|xml)$|(^|\/)[^.\/]+$/i;
const MAX_FILE = 8 * 1024 * 1024;
// 预先下载的总量预算：超过的列给 Agent 按需取，首次拉取控制在一两分钟内
const MAX_TOTAL = 20 * 1024 * 1024;
// 本次 fetch 没下到的文件（非 SKILL.md），和超出预算没预先下载的文件
const missing = [];
const skipped = [];
// 缓存多久内不检查更新；STYLE_HUB_FRESH_MINUTES=0 每次都查最新
const FRESH_MS = Number(process.env.STYLE_HUB_FRESH_MINUTES ?? 60) * 60_000;

const [cmd, ...args] = process.argv.slice(2);
const index = await loadIndex();

if (cmd === "list") {
  for (const s of index.styles) console.log(line(s));
} else if (cmd === "search") {
  const terms = args.join(" ").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = index.styles.filter((s) => terms.every((t) => haystack(s).includes(t)));
  if (!hits.length) console.log("没有匹配的风格。用 list 看全部。");
  for (const s of hits) console.log(line(s));
} else if (cmd === "show") {
  console.log(JSON.stringify(find(args[0]), null, 2));
} else if (cmd === "fetch") {
  await fetchStyle(find(args[0]));
} else {
  console.log("用法：node hub.mjs list | search <关键词> | show <slug> | fetch <slug>");
  process.exit(cmd ? 2 : 0);
}

function line(s) {
  return `${s.slug} | ${s.name} | ${s.form} | ${s.summary}`;
}

function haystack(s) {
  return [s.slug, s.name, s.summary, s.form, s.author, ...s.tags].join(" ").toLowerCase();
}

function find(key) {
  if (!key) fail(2, "缺风格名：fetch <slug>");
  const s = index.styles.find((x) => x.slug === key) ?? index.styles.find((x) => x.name === key);
  if (!s) fail(2, `没有「${key}」这个风格。用 search 或 list 查 slug。`);
  return s;
}

async function fetchStyle(s) {
  const { repo } = s.source;
  const dir = path.join(CACHE, s.slug);
  const metaFile = path.join(CACHE, `${s.slug}.json`);
  const meta = readJson(metaFile);
  const cachedOk = meta && existsSync(path.join(dir, "SKILL.md"));

  // 一小时内拉过就不再问 GitHub：省时间，也省每小时 60 次的 API 限额
  const fresh = cachedOk && meta.commit && Date.now() - Date.parse(meta.fetched_at) < FRESH_MS;
  if (fresh) return report(s, dir, meta.commit, meta.partial);

  // 最新 commit 和文件列表；都拿不到（离线）时先用缓存
  const tree = await repoTree(repo);
  if (cachedOk && (!tree || tree.commit === meta.commit)) return report(s, dir, meta.commit, meta.partial);

  const tmp = `${dir}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  let partial = false;
  let commit;
  try {
    if (tree) {
      commit = tree.commit;
      // 作者从压缩包改成直接放目录时，按目录拉
      const zipGone = s.source.archive && !tree.files.some((f) => /\.zip$/i.test(f.path));
      if (s.source.archive && !zipGone) await writeArchive(repo, commit, tree.files, s.source.archive, tmp);
      else await writeDirectory(repo, commit, tree.files, zipGone ? "" : s.source.path, tmp);
    } else {
      // 没有文件树：至少把 SKILL.md 拿下来，它引用的文件交给 Agent 按需再取
      commit = "HEAD";
      partial = true;
      const p = s.source.path ? `${s.source.path.replace(/\/$/, "")}/SKILL.md` : "SKILL.md";
      if (s.source.archive) throw new Error("查不到仓库文件列表，压缩包发布的风格暂时拉不了");
      put(tmp, "SKILL.md", await download(repo, "HEAD", p));
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (cachedOk) return report(s, dir, meta.commit, meta.partial);
    fail(5, `${e.message}\n访问不了 GitHub 时，可以把 STYLE_HUB_RAW 设成镜像前缀再试。`);
  }

  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  mkdirSync(CACHE, { recursive: true });
  // 有文件没下到时不记 commit，下次 fetch 会重拉
  writeFileSync(metaFile, JSON.stringify({ commit: missing.length ? null : commit, partial, skipped, fetched_at: new Date().toISOString() }));
  report(s, dir, commit, partial);
  if (missing.length) {
    console.log(`有 ${missing.length} 个文件没下到，用到时按下面的地址取，放到目录里对应位置：`);
    for (const m of missing) console.log(`  ${m.to}  ${m.url}`);
  }
  if (skipped.length) {
    const base = skipped[0].url.slice(0, skipped[0].url.length - enc(skipped[0].to).length);
    console.log(`Skill 目录很大，有 ${skipped.length} 个文件没预先下载（多为参考图）。SKILL.md 用到哪个再取哪个：${base}<目录里的相对路径>`);
    for (const m of skipped.slice(0, 5)) console.log(`  ${m.to}`);
    if (skipped.length > 5) console.log(`  …另有 ${skipped.length - 5} 个`);
  }
}

// 目录发布：取 SKILL.md 所在目录；作者挪了目录时，仓库里只有一个 SKILL.md 就用它
async function writeDirectory(repo, commit, files, skillPath, out) {
  let prefix = skillPath ? `${skillPath.replace(/\/$/, "")}/` : "";
  if (!files.some((f) => f.path === `${prefix}SKILL.md`)) {
    const all = files.filter((f) => /(^|\/)SKILL\.md$/.test(f.path));
    if (all.length !== 1) throw new Error("仓库里找不到这个风格的 SKILL.md（作者可能改了结构）");
    prefix = all[0].path.slice(0, -"SKILL.md".length);
  }
  const text = [];
  const images = [];
  const other = [];
  for (const f of files) {
    // Skill 在子目录时，仓库根的 LICENSE 单独放到 _repo/ 下
    if (prefix && /^LICEN[CS]E(\.(md|txt))?$/i.test(f.path)) {
      text.push({ from: f.path, to: `_repo/${f.path}`, size: f.size });
      continue;
    }
    if (!f.path.startsWith(prefix)) continue;
    const rel = f.path.slice(prefix.length);
    const item = { from: f.path, to: rel, size: f.size };
    if (rel === "SKILL.md") text.push(item);
    else if (SKIP.test(rel) || VIDEO.test(rel) || f.size > MAX_FILE) continue;
    else if (IMAGE.test(rel)) images.push(item);
    else if (TEXT.test(rel)) text.push(item);
    else other.push(item);
  }
  // 先下文字文件，再只下被它们提到文件名的图片（风格参考图会被引用，作者的成品展示通常不会）
  await downloadAll(repo, commit, text, out);
  const mentioned = text.map((t) => readText(path.join(out, t.to))).join("\n");
  const used = images.filter((i) => mentioned.includes(path.posix.basename(i.to)));
  // 总量超过预算时按顺序下到预算为止，剩下的列给 Agent 按需去取，不整个放弃
  const take = [];
  let budget = MAX_TOTAL;
  for (const f of [...other, ...used]) {
    if (f.size <= budget) {
      take.push(f);
      budget -= f.size;
    } else skipped.push({ to: f.to, url: urls(repo, commit, f.from)[0] });
  }
  await downloadAll(repo, commit, take, out);
}

function readText(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// 压缩包发布：下载仓库里那个 zip，解出包内 SKILL.md 所在目录
async function writeArchive(repo, commit, files, archive, out) {
  const want = archive.file.normalize("NFC");
  let zip = files.find((f) => f.path.normalize("NFC") === want);
  if (!zip) {
    const zips = files.filter((f) => /\.zip$/i.test(f.path));
    if (zips.length !== 1) throw new Error(`仓库里找不到 Skill 压缩包 ${archive.file}（作者可能改了结构）`);
    zip = zips[0];
  }
  if (zip.size > MAX_TOTAL) throw new Error(`Skill 压缩包超过 ${MAX_TOTAL / 1048576}MB，不自动拉取`);
  const inner = unzip(await download(repo, commit, zip.path, zip.size)).filter((e) => !e.name.startsWith("__MACOSX/"));
  const target = archive.dir ? `${archive.dir.replace(/\/$/, "")}/SKILL.md` : "SKILL.md";
  // 包外可能多套一层目录：取以 target 结尾、层级最浅的那个
  const md =
    inner.filter((e) => e.name === target || e.name.endsWith(`/${target}`)).sort((a, b) => a.name.length - b.name.length)[0] ??
    single(inner.filter((e) => /(^|\/)SKILL\.md$/.test(e.name)));
  if (!md) throw new Error("压缩包里找不到 SKILL.md");
  const prefix = md.name.slice(0, -"SKILL.md".length);
  // 和目录发布同样的取舍：跳过示例与文档，图片只留被文字文件提到的
  const keep = inner
    .filter((e) => e.name.startsWith(prefix))
    .map((e) => ({ rel: e.name.slice(prefix.length), data: e.data }))
    .filter((e) => e.rel === "SKILL.md" || !(SKIP.test(e.rel) || VIDEO.test(e.rel)));
  const mentioned = keep.filter((e) => !IMAGE.test(e.rel)).map((e) => e.data.toString("utf8")).join("\n");
  for (const e of keep) if (!IMAGE.test(e.rel) || mentioned.includes(path.posix.basename(e.rel))) put(out, e.rel, e.data);
  const licenses = files.filter((f) => /^LICEN[CS]E(\.(md|txt))?$/i.test(f.path)).map((f) => ({ from: f.path, to: `_repo/${f.path}` }));
  await downloadAll(repo, commit, licenses, out);
}

// 4 个并发；SKILL.md 必须成功，其余文件失败记进 missing，最后在输出里列出来
async function downloadAll(repo, commit, list, out) {
  const queue = [...list];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        put(out, item.to, await download(repo, commit, item.from, item.size));
      } catch (e) {
        if (item.to === "SKILL.md") throw e;
        missing.push({ to: item.to, url: urls(repo, commit, item.from)[0] });
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (!existsSync(path.join(out, "SKILL.md"))) throw new Error("SKILL.md 下载失败");
}

function enc(p) {
  return p.split("/").map(encodeURIComponent).join("/");
}

// jsDelivr 在国内通常比 raw.githubusercontent 快很多；设了 STYLE_HUB_RAW 时只用它
function urls(repo, ref, p) {
  if (process.env.STYLE_HUB_RAW) return [`${RAW}/${repo}/${ref}/${enc(p)}`];
  return [`https://cdn.jsdelivr.net/gh/${repo}@${ref}/${enc(p)}`, `${RAW}/${repo}/${ref}/${enc(p)}`];
}

function single(list) {
  return list.length === 1 ? list[0] : undefined;
}

function report(s, dir, commit, partial) {
  console.log(`风格：${s.name}（${s.slug}）`);
  console.log(`作者：@${s.author} · ${s.license} · 版本 ${String(commit).slice(0, 7)}`);
  console.log(`SKILL.md：${path.join(dir, "SKILL.md")}`);
  console.log(`目录：${dir}`);
  console.log(`来源：https://github.com/${s.source.repo}`);
  if (partial) {
    const base = s.source.path ? `${s.source.path.replace(/\/$/, "")}/` : "";
    console.log(`只拿到了 SKILL.md；它引用的其他文件从 ${RAW}/${s.source.repo}/HEAD/${base}<相对路径> 取`);
  }
  if (s.notice) console.log(`许可提示：${s.notice}`);
}

// 写文件前确认路径不会跳出目标目录（压缩包里的 ../ 之类）
function put(base, rel, data) {
  if (!rel || rel.endsWith("/")) return;
  const root = path.resolve(base);
  const p = path.resolve(root, rel);
  if (!p.startsWith(root + path.sep)) return;
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, data);
}

// 最新 commit 用 GitHub API（1 次），之后所有下载都钉在这个 commit 上，避免中途作者推新提交拿到前后不一致的文件。
// 文件列表先问 jsDelivr（不占 GitHub 限额），仓库超过 jsDelivr 的 50MB 上限时再用 GitHub 的 tree 接口（多 1 次）
async function repoTree(repo) {
  const commit = await getJson(`${API}/repos/${repo}/commits/HEAD`, github());
  if (!commit?.sha) return null;
  const flat = await getJson(`https://data.jsdelivr.com/v1/packages/gh/${repo}@${commit.sha}?structure=flat`);
  if (Array.isArray(flat?.files)) {
    return { commit: commit.sha, files: flat.files.map((f) => ({ path: f.name.replace(/^\//, ""), size: f.size ?? 0 })) };
  }
  const tree = await getJson(`${API}/repos/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`, github());
  if (!Array.isArray(tree?.tree)) return null;
  return { commit: commit.sha, files: tree.tree.filter((e) => e.type === "blob").map((e) => ({ path: e.path, size: e.size ?? 0 })) };
}

function github() {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function getJson(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// 每个文件依次试各个来源；超时按文件大小放宽（按 30KB/s 算，至少 30 秒）
async function download(repo, ref, p, size = 0) {
  const timeout = Math.max(30_000, Math.ceil((size / 30_000) * 1000));
  for (const url of urls(repo, ref, p)) {
    for (let i = 0; i < 2; i++) {
      const t = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        debug(`${res.status} ${Date.now() - t}ms ${url}`);
        if (res.status === 404 || res.status === 403) break;
      } catch (e) {
        debug(`${e.name} ${Date.now() - t}ms ${url}`);
      }
    }
  }
  throw new Error(`下载失败：${repo}/${p}`);
}

function debug(msg) {
  if (process.env.STYLE_HUB_DEBUG) console.error(`[debug] ${msg}`);
}

// zip：读中央目录，支持存储（0）和 deflate（8）。文件名没标 UTF-8 时按 GBK 解（国内常见的打包工具）
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Skill 压缩包损坏");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const raw = buf.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const name = decodeName(raw, flags).replace(/\\/g, "/");
    if (name.endsWith("/")) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    if (method === 0) out.push({ name, data: body });
    else if (method === 8) out.push({ name, data: inflateRawSync(body) });
  }
  return out;
}

function decodeName(raw, flags) {
  if (flags & 0x800) return raw.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return new TextDecoder("gbk").decode(raw);
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function loadIndex() {
  const url = process.env.STYLE_HUB_INDEX;
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const j = res.ok ? await res.json() : null;
      if (j?.version === 2 && Array.isArray(j.styles)) return j;
    } catch {}
  }
  return JSON.parse(readFileSync(path.join(HERE, "..", "index.json"), "utf8"));
}

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}
