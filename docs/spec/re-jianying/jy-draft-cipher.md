# 剪映 11.6.0.14552 草稿 `draft_content.json` 编码层逆向报告

> 任务：task-3 ｜ 样本：`D:\JianyingPro Drafts\9月20日\draft_content.json`（41980 B，只读）
> 目标版本：`D:\JianyingPro\11.6.0.14552`（只读）｜ 出具日期：2026-10-27
> 复现脚本：[`decode-draft.mjs`](./decode-draft.mjs)

## 0. 结论（先给答案）

**未解开。** `draft_content.json` 的明文 JSON 在本次环境下**没有拿到**，因此
**tracks / segments / target_timerange / source_timerange / volume / speed /
materials.path / duration / transitions / beats 的字段值全部不可得**。
本报告**不提供任何推测值**——凡未测到的字段一律留空。

但已经把它拆到了「可解点」，并且**证伪了任务书里最主要的两个假设**
（"自定义字母表 base64" 与 "轻量变换"）：

| 判定项 | 结论 | 关键数字 |
|---|---|---|
| 第 1 层编码 | **标准 base64**（标准字母表 `A-Za-z0-9+/`，`=` 填充） | 严格往返校验 PASS；字符集外字符 0 |
| 第 2 层内容 | **高熵二进制密文**（非文本、非压缩） | 熵 7.995 bit/byte；χ²=233.7（df=255）；可打印率 37.2 % |
| 是否「自定义字母表 base64(明文 JSON)」 | **已证伪** | 样本四个位置类均为 64/64 种符号；真实 JSON 对照组仅 17–40 种 |
| 是否静态密钥流 XOR | **否**（per-file nonce） | 同草稿两次保存，密文相同前缀 = 0 字节，异或零字节率 0.34 % ≈ 随机 0.39 % |
| 是否分组密码 CBC/ECB | **否**（长度不合法） | 31483 B，`% 16 = 11` |
| 加密实现位置 | **`videoeditor.dll`** 内 `EncryptUtils`（CryptoPP 支撑） | 见 §4，含 3 个精确函数 RVA |

一句话：**这是带 per-file nonce 的真实对称加密，不是编码混淆，也不是可逆的轻量变换。**

### 对任务书前提的两处更正（实测）

1. 任务书说"字母表含 0-9A-Za-z 但无 `+` `/`"——**实测文件里有 `+` 和 `/`，也有 `=` 填充**（字符集 65 个符号 = 64 字母 + `=`）。
2. 任务书说"长度与原文大致同阶"——实为 `41980 = 4 × 10495`，解码后 **31483 B**，
   即原文的 3/4（这正是 base64 的膨胀比），说明被编码的原始载荷约 31.5 KB，**不是 42 KB**。

---

## 1. 样本与文件族

`9月20日` 草稿目录下同名/近名文件的实测关系（全部只读比对）：

| 文件 | 字节 | 开始字符 | 性质 |
|---|---|---|---|
| `draft_content.json` | 41980 | `6hEcZg7B4b786...` | 密文（本报告主样本） |
| `draft_content.json.bak` | 41980 | `JIF6kAMBCedpn...` | 密文（上一次保存） |
| `template-2.tmp` | 41980 | `6hEcZg7B4b786...` | **与 `draft_content.json` 逐字节相同** |
| `Timelines\<id>\draft_content.json` | 41980 | 同上 | 与顶层同名文件逐字节相同（外层草稿 / 时间线草稿双份） |
| `template.tmp` | 3959 | `{"canvas_config":...` | **明文 JSON**（空草稿骨架，见 §3） |
| `draft_meta_info.json` | 14460 | `Fa22dUZ0gBciT0T...` | 密文（同一套方案；解码 10845 B，熵 7.984） |
| `draft_settings` | 152 | `[General]` | 明文 INI |
| `key_value.json` | 25667 | `{"2E937A64-...` | 明文 JSON（素材元数据，**无任何密钥字段**） |
| `draft_virtual_store.json` / `timeline_layout.json` / `attachment_*.json` / `project.json` | 小 | 明文 | 全部为工程/布局/素材元数据，**不含时间线** |

三份草稿（`9月19日` / `9月20日` / `9月26日`）的 `draft_content.json` **全部是密文**，
样本库中**不存在任何明文 `draft_content.json`**（已递归枚举全部 12 个 `draft_content.json*`）。

---

## 2. 格式判定（第 1 层：标准 base64）

判据（均可由 `decode-draft.mjs` 复现）：

| 检查 | 结果 |
|---|---|
| 文本长度 | 41980，`41980 % 4 = 0` ✔ |
| 字符集 | 完全落在 `A-Za-z0-9+/=`，越界字符 0 个 ✔ |
| `=` 的出现位置 | 只有结尾 2 个（`...cA==`），中间无 `=` ✔ |
| 不同符号数 | 64/64 全部用到 |
| **严格往返校验** | `Buffer.from(s,'base64').toString('base64')` 去 padding 后与原串逐字符相等 → **PASS** |

往返校验是关键：任何"自定义/置换字母表"的实现，用标准字母表解码后再编码都**无法**回到原文。
本样本能完美往返，说明**第 1 层就是标准 base64，字母表没有被置换**。

> 这一点与 §5 的位置类判定互相印证，也是**推翻任务书"自定义字母表"假设的第一条硬证据**。

---

## 3. 明文长什么样（来自唯一明文样本 `template.tmp`，非本次解密所得）

`9月20日\Timelines\<id>\template.tmp` 是剪映保存时写出的**明文空草稿骨架**（3959 B）。
它证明明文 `draft_content.json` 的结构是：

```
顶层键(36)：canvas_config, color_space, config, cover, create_time, draft_type, duration,
            extra_info, fps, free_render_index_mode_on, function_assistant_info,
            group_container, id, is_drop_frame_timecode, keyframe_graph_list, keyframes,
            last_modified_platform, lyrics_effects, materials, mixed_track_mode_on,
            mutable_config, name, new_version, path, platform, relationships,
            render_index_track_mode_on, retouch_cover, smart_ads_info, source,
            static_cover_image_path, time_marks, tracks, uneven_animation_template_info,
            update_time, version
```

- `materials` 是**对象**，内含 **55 个数组类别**（`videos` / `audios` / `images` / `texts` / `beats` / `transitions` / `speeds` / `audio_fades` / …）。
- `tracks` 是数组，每项 `{type, id, segments:[{material_id, target_timerange, source_timerange, speed, volume, extra_material_refs, …}]}`。
- `version: 360000`，`new_version: "75.0.0"`，`fps: 30`。

**这份骨架 `tracks` 为空、`duration = 0`**，所以它提供的是**schema，而不是用户想要的真实时间线**。
切勿把它当作 9月20日 草稿的明文——它不是。

`--plain` 模式可直接对任意明文草稿打印任务要求的那张结构摘要表：

```powershell
node docs/spec/re-jianying/decode-draft.mjs --plain "<任意明文 draft_content.json>"
```

---

## 4. 加密实现定位（本次逆向的主要产出）

### 4.1 证据来源：`videoeditor.dll`（72,547,608 B）

在该 DLL 的 `.rdata` 字符串表中定位到完整的草稿加密子系统（偏移为文件偏移，VA = `0x180000000 + RVA`）：

| 文件偏移 | 字符串 | 含义 |
|---|---|---|
| `0x31e67b0` | `jianying_draft_encrypt_v2` | **加密方案标识（v2）** |
| `0x31e5b58` | `crypto_key_store.dat` | **密钥库文件名**（本机不存在，见 §4.4） |
| `0x31e5b10` | `cryptor_type` | 密钥库 JSON 字段 |
| `0x31e5bb0..0x31e5bd0` | `kNone` `kGlobal` `kCurrent` `kTemporary` | 密钥作用域枚举 |
| `0x31e5e98..0x31e5ec0` | `optional_context` `cipher_type` `cipher_key` | 密钥库字段 |
| `0x31e5f20` | `C:\32139\videoeditor\lyra\trash_src\encrypt\crypto_key_store.cpp` | 源文件路径（泄露内部目录结构） |
| `0x31e7e00` | `...\encrypt\encrypt_utils_2.cpp` | 另一套加解密实现 |
| `0x31e8250` | `...\encrypt\encrypt_utils_impl.cpp` | 加解密实现 |
| `0x31e7d80` | `decrypt error encryptStr = {:.{}}, content_length = {}, read_content_length = {}, decryptStr = {} header_length = {}` | 解密失败日志（**存在 header**） |
| `0x31e8298` | `decrypt error encryptStr = {}, decryptStr = {}` | `decryptImpl` 的失败日志 |
| `0x31e0380..0x31e04a0` | `decryptKV2` / `is not crypted by KV2` / `decrypt error, start recovery` | IOManager 的 KV2 解密路径 |
| `0x31e0d80` | `[DRAFT_IO_MANAGER] IOFileData::write: encrypt file content error` | **写文件时加密** |
| `0x31e0c80` | `[DRAFT_IO_MANAGER] IOFileData::initData: decrypt file fail` | 读文件时解密 |
| `0x31e5800` | `is_encrypted` | 虚拟库里的加密标志 |

符号表（`.rdata` 的修饰名区）暴露了类与方法：

```
?decrypt@EncryptUtils@lvve@@QEAA?AV basic_string ... AEBV34@0@Z
?decrypt@EncryptUtils@lvve@@QEAA?AV basic_string ... AEBV34@0AEA_N@Z
?encrypt@EncryptUtils@lvve@@QEAA?AV basic_string ... AEBV34@@Z
?decryptFileBytes@EncryptUtils@lvve@@SAHPEBD0AEAV?vector@E...@@@Z
?decryptFileStream@EncryptUtils@lvve@@SA?AV?shared_ptr@VLVVEDecryptStream@lvve@@...@Z
?calcEntropyDynamicString@EncryptUtils@lvve@@SA?AU?pair@Vbasic_string...V?array@D$0CA@@...@Z   ← 返回 pair<string, array<char,33>>
?maybeEncrypted@EncryptUtils@lvve@@QEAA_NAEBV?basic_string_view...@Z
?isFileEncrypted@EncryptUtils@lvve@@SA_NPEBD@Z
?draftEncryptEnable@DraftStoreManager@draft_store@@QEAA_NXZ
?isDraftEncryptionEnable@DraftStore@draft_store@@QEBA_NXZ
?draftCipherType@DraftStore@draft_store@@QEBA?AW4DraftCipherType@2@XZ
?maxCipher@DraftIO@draft_store@@SA?AW4DraftCipherType@2@XZ
?upgradeDraftCipherType@DraftStore@draft_store@@QEAAXW4DraftCipherType@2@@Z
?readRawDraftFile@DraftStore@draft_store@@AEAA?...PEAW4DraftCipherType@2@@Z
```

并且 DLL 里静态链接了 **CryptoPP**，可见 `Rijndael`（AES）、`CTR_ModePolicy`、
`AuthenticatedEncryptionFilter` / `AuthenticatedDecryptionFilter`（AEAD）、
`Base64Decoder` / `Base64Encoder` 等符号。字符串里还有 `SHA-1` `MGF1` `OAEP-`（用于 RSA 包裹输出密钥，与草稿本身无关）。

### 4.2 三个精确函数入口（可直接喂给反编译器）

用「`.pdata` 异常目录 + RIP 相对 xref 扫描」定位（方法见 §7），得到**函数级精确边界**：

| RVA（VA = 0x180000000 + RVA） | 长度 | 依据 | 推断 |
|---|---|---|---|
| `0x137e360`（VA `0x18137e360`） | 2388 B | 函数体内引用 `decrypt error encryptStr = {}, decryptStr = {}` | **`EncryptUtils::decryptImpl`**（`encrypt_utils_impl.cpp`） |
| `0x137b600`（VA `0x18137b600`） | 4384 B | 函数体内引用含 `header_length = {}` 的解密失败日志 | **`EncryptUtils::decrypt`**（`encrypt_utils_2.cpp`，有 header） |
| `0x1379a10`（VA `0x181379a10`） | 661 B | 引用字符串 `jianying_draft_encrypt_v2` | 加密开关/方案选择（`needEncrpyt` 或配置读取） |
| `0x137f570`（VA `0x18137f570`） | 406 B | 引用 `0123456789abcdefghijABCDEFGHIJ` | 某种自定义字符编码表（30 符号） |

`jianying_draft_encrypt_v2` 字符串紧邻之后（`0x31e67d0`–`0x31e68cf`）是一个
**恰好 256 B 的常量块**。已检验：**不是置换表**（只有 160/256 个不同字节，随机数据期望 ≈160.6），
**不是 AES S-box**（与标准 S-box 仅 1/256 巧合相同），**不是 64 符号字母表**。
→ 判定为随机常量（很可能是一段内置密钥/盐或无关填充），**不可单独当作解密表使用**。

### 4.3 本机工具链限制（为什么没继续反编译）

| 工具/Provider | 状态 |
|---|---|
| Ghidra（REA `ghidra` provider） | **未配置**：`GHIDRA_INSTALL_DIR` 未设置、`java.exe` 不可用 → 无法反编译 |
| Rizin（`execute_rizin_command`） | **Windows 上不可用**：`ERR_REA_WINDOWS_NATIVE` |
| objdump / llvm-objdump / ndisasm / gdb / dumpbin | **系统内均不存在** |
| Hopper | macOS 专用 |

也就是说：**定位到了函数，但本机没有可用的反汇编器/反编译器去读它**。这是本次未能继续的唯一硬约束。

### 4.4 密钥不在可离线读取的文件里

- 全盘检索 `C:\Users\14872\AppData\Local\JianyingPro`、`D:\JianyingPro`、`D:\JianyingPro Drafts`：
  **`crypto_key_store.dat` 不存在**，也没有任何 `*encrypt* / *cipher* / *key_store* / *.mmkv` 文件。
- 明文 `key_value.json`（25667 B）中 `encrypt / cipher / crypto / key_store / is_encrypted / cryptor` **命中数均为 0**。
- `draft.extra`（26 B）只是 `69 06 00 00 00 69 ... 7B 7D 99 C0 65 C3` 的小结构，`{}` 为空 JSON，**不是密钥**。
- 结论：密钥来自 **`calcEntropyDynamicString`（机器/环境派生的 32 字节，配合 `array<char,33>`）**
  或**服务端下发后仅缓存在内存/KEY 库**。两种情形都无法仅凭磁盘文件离线复原。

---

## 5. 已排除项（每条都可复现，均带实测数字）

> 以下即任务要求的「未解开时必须给出的 ≥3 条可验证负向证据」，实际给了 6 条。
> 全部由 `node docs/spec/re-jianying/decode-draft.mjs` 一条命令打印。

### N1 — 不是「自定义/置换字母表 base64(明文 JSON)」（**决定性**）

**原理**：base64 每 4 字符一组，第 1 个字符 = `b0 >> 2`，只承载 `b0` 的高 6 位。
ASCII JSON 的每个字节都 `< 0x80`，所以 `b0 >> 2 ∈ [0,31]` —— **位置 0 最多只能出现 32 种符号**。
字母表被"置换"只会改变"是哪些符号"，**不会改变不同符号的个数**。

| 对象 | 位置 0/1/2/3 的不同符号数 |
|---|---|
| **样本（密文）** | **64 / 64 / 64 / 64** |
| `template.tmp`（真实明文草稿 JSON） | 17 / 22 / 31 / 34 |
| `key_value.json`（真实明文 JSON） | 40 / 43 / 57 / 52 |
| 合成紧凑 JSON（基线） | 15 / 19 / 27 / 27 |

样本在位置 0 就用满了 64 种符号 → 底层字节覆盖全域 0–255 → **明文不是 ASCII JSON**
→ **"自定义字母表 base64" 假设被证伪**（配合 §2 的往返 PASS，双重独立证据）。

### N2 — 不是压缩（gzip / zlib / zstd / lz4 / xz / bzip2）

| 格式 | magic 命中 |
|---|---|
| gzip `1F 8B` | false |
| zlib `78` | false |
| zstd `28 B5 2F FD` | false |
| lz4 `04 22 4D 18` | false |
| xz `FD 37 7A 58 5A` | false |
| bzip2 `42 5A 68` | false |

且熵 `7.995 bit/byte`、首字节 `EA`（非 `{`）、可打印率仅 37.2 %。
压缩流通常 7.5–7.99 且保留可识别表头/字典结构，这里没有。

### N3 — 不是按字节替换（S-box）或置换/换位

若是单字节替换或转置，密文的**字节直方图**只会是明文直方图的"重排"，
而 JSON 的字节分布极度尖峰（`"` `,` `:` 空格 数字 字母）。
实测密文直方图**近乎均匀**：最高单字节频率 `0.48 %`（均匀期望 0.39 %），
`χ² = 233.7`（df=255，均匀期望 ≈255，即"和随机不可区分"）。
→ 替换类/转置类密码**不可能**产生这种分布，排除。

### N4 — 不存在密钥流复用（静态 XOR 攻击不可用）

同一草稿连续两次保存的密文（`draft_content.json` vs `.bak`，两者解码后**长度完全相同** 31483 B，
说明明文规模一致）：

| 指标 | 实测 | 随机基线 |
|---|---|---|
| 密文相同前缀字节数 | **0** | — |
| 异或为 0 的字节占比 | **0.34 %** | 1/256 ≈ **0.39 %** |
| 异或头 32 B | `ce9066f60dc0e8599577d4d7d863a515...` | 无结构 |

从**第 0 字节**起就不同 → 连"文件头里有明文版本号"都没有 → **每个文件都有独立 nonce/IV**。
三对文件（9-19、9-20、9-26 的 `.json` vs `.bak`）表现一致。

### N5 — 不是 AES/DES/SM4 的 ECB/CBC + PKCS#7

AES/SM4 块长 16、DES 块长 8，带 PKCS#7 填充的密文长度必为块长整数倍。
实测 `31483 % 16 = 11`、`31483 % 8 = 3` → **两者都不成立**。
（`9月19日`=802 B、`9月26日`=786 B，`% 16` 分别为 2、2，同样不成立。）

### N6 — 明文侧车（sidecar）里没有时间线

`draft_settings` / `timeline_layout.json` / `key_value.json` / `draft_virtual_store.json` /
`attachment_*.json` / `project.json` / `performance_opt_info.json` / `draft_agency_config.json`
全部逐份读过（见 §1 表）：只有工程 id、时间戳、素材元数据、布局、AI 开关，
**没有任何 track / segment / timerange / volume / beats**。
`agent_adoption_ledger.db`（明文 SQLite，106496 B）只有 `adoption_records`、
`tool_call_results`、`agent_action_tracking_snapshots` 等**采纳记录/动作元数据**表，
且 `agent_action_tracking_snapshots` 实为 **0 行**；`deepagent.db` 本身也是密文（无 SQLite 头）。
→ 想从旁路拿到时间线：**此路不通**。

---

## 6. 从明文文件确实测到的工程事实（明确声明：**不是**解密所得）

以下数据来自明文侧车文件，可作为时间线的**外围真值**，但不含片段细节：

| 事实 | 值 | 来源 |
|---|---|---|
| 草稿 id（时间线） | `A6A8A0C4-CF3C-4b9f-AD99-5BBCCFB99D65` | `timeline_layout.json` / `project.json` |
| 工程 id | `EB80AEA3-9CEC-4c70-B0E0-9D94AC4F5324` | `Timelines/project.json` |
| 时间线名称 | `时间线01` | `timeline_layout.json` |
| 工程创建时间 | `1789916949898957` µs | `Timelines/project.json` |
| 草稿创建时间 | `1789916948`（s） | `draft_settings` |
| 最后编辑时间 | `1790073126`（s） | `draft_settings` |
| **真实编辑时长** | `real_edit_seconds = 1387`（≈23 分 07 秒） | `draft_settings` |
| 输出分辨率档 | `video_resolution = 720` | `draft_agency_config.json` |
| 容器版本 | `version 360000` / `new_version "75.0.0"`，`fps 30` | `template.tmp` |
| 子草稿/素材占位 id | 9 个 `child_id`（UUID） | `draft_virtual_store.json` |

> `draft_virtual_store.json` 里那 9 个 `child_id`（`bae0f760-…` 等）**是"虚拟库槽位/子草稿占位"，
> 不是片段 id**，也不带时间信息。不要把它们当 segment 索引使用。

---

## 7. 定位方法（供后续接手者复用）

无任何反汇编器时，仍可把"哪个函数在处理草稿加解密"钉死。三步：

1. **字符串 → 文件偏移**：在 `videoeditor.dll` 中扫 ASCII 串，得到 `jianying_draft_encrypt_v2` 等偏移。
2. **文件偏移 → VA**：解析 PE 头（6 个节 + `ImageBase = 0x180000000`），
   逐节 `VA = ImageBase + Section.VirtualAddress + (fileOffset - Section.PointerToRawData)`。
3. **VA → 函数边界**：先扫 `.text` 找 RIP 相对 xref —— 对每个位置 `o` 读 `int32(o)`，
   若 `(o+4) + disp == targetVA` 即命中（覆盖所有以 disp32 结尾的 `lea/mov/call/jmp`）；
   再解析 `.pdata`（`RUNTIME_FUNCTION` = 12 B：`BeginAddress/EndAddress/UnwindInfo`，共 **99109** 条）
   得到"包含该 xref 的函数"的精确起止。

关键数字速查：`ImageBase=0x180000000`、`.text`（RVA `0x1000`, raw `0x400`, size `0x3064600`）、
`.rdata`（RVA `0x3066000`, raw `0x3064a00`）。

---

## 8. 下一步需要的证据（按性价比排序）

| # | 需要什么 | 怎么做 | 成功标志 |
|---|---|---|---|
| **1** | **反编译 `0x18137e360` 与 `0x18137b600`** | 装 Ghidra 12.1.x + JDK，设 `GHIDRA_INSTALL_DIR`，再 `open_binary` → `analyze_function`。或用任意本机反汇编器（本项目环境全都没有） | 能看到 IV/nonce 的取法、`cipher_type` 分支，以及 32 字节密钥来自哪里 |
| **2** | **运行时抓密钥**（最高性价比，但**需要用户授权**） | 用 Frida attach/spawn `JianyingPro.exe`，hook `EncryptUtils::decrypt`（`0x18137b600`）入口，dump `cipher_key` / IV / 算法 id；或 hook `calcEntropyDynamicString` 看它返回的 32 字节 | 拿到 (alg, key, iv)，即可离线复现全部草稿 |
| **3** | **搞清 `crypto_key_store.dat` 的生成条件** | 该文件本机不存在。查 `crypto_key_store.cpp` 的 `addKey/queryKey/do_uncompress`，确认密钥是"机器派生"还是"服务端下发/仅内存" | 若是机器派生，只需复现 KDF 即可（不需要抓包） |
| **4** | **找一份同版本但明文的历史草稿** | 若用户有更老版本的剪映，或手机端剪映导出的同工程草稿，其 `draft_content.json` 可能是明文 → 直接得到 schema 与真实字段，还可做已知明文分析 | 拿到明文即可直接给结构摘要，无需解密 |
| **5** | **合法旁路** | 在**用户本人**允许的前提下，用剪映 GUI 打开草稿并"另存为模板 / 导出工程"，看是否落出明文字段 | 这是产品自带的正当路径，但不属于本次"禁止启动 GUI"的范围 |

> 提醒接手者：**以上 1–5 都还没有做**，所以本报告不能说"能解开"，只能说"卡在密钥/反编译工具"。
> 另外 §4.2 的 4 个 RVA 是**已实测确认**的，可直接作为反编译起点，不必重新扫。

---

## 9. 复现命令

```powershell
cd "C:\Users\14872\Desktop\测试"

# 打印本报告的全部数字（§2/§5 的负向证据）
node docs/spec/re-jianying/decode-draft.mjs

# 指定其它草稿
node docs/spec/re-jianying/decode-draft.mjs "D:\JianyingPro Drafts\9月26日\draft_content.json"

# 若日后拿到明文：直接打印 tracks/segments/volume/speed/materials/transitions/beats 摘要
node docs/spec/re-jianying/decode-draft.mjs --plain "<明文 draft_content.json>"
```

脚本**只读**样本，**不写任何文件**，**不联网**。
`D:\JianyingPro Drafts` 下文件未被修改（仅 `ReadAllBytes` / `readFileSync`）。

---

## 10. 状态汇总（三态，不许含糊）

| 事项 | 状态 |
|---|---|
| 识别第 1 层编码 | **通过**（标准 base64，往返校验 PASS） |
| 判定第 2 层性质 | **通过**（高熵密文，per-file nonce） |
| 证伪"自定义字母表 base64" | **通过**（位置类 64/64 vs 对照组 17–40） |
| 定位加密实现位置 | **通过**（`videoeditor.dll` + 3 个函数 RVA） |
| **取出明文 JSON** | **不通过 / 未完成** |
| tracks / segments / timerange / volume / speed / materials / transitions / beats 字段值 | **未验证（不可得）** |
| 定位 `crypto_key_store.dat` | **未验证**（本机不存在） |
| 反编译 `EncryptUtils` | **未验证**（本机无可用反汇编器） |
