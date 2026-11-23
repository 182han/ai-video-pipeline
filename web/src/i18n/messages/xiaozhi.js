// ============================================================
// i18n · 小智展示组件（计划卡 / 状态条 / 审图卡 / 首页气泡 / 麦克风）
// 与 assistant.* 分开：本文件对应 components/xiaozhiPlan.js。
// ============================================================
export default {
  zh: {
    xiaozhi: {
      plan: {
        cardTitle: '小智 · 计划卡',
        sceneMode: '场景卡模式',
        freePrompt: '自由提示词',
        edit: '改一下',
        duration: '时长',
        theme: '主题',
        model: '模型',
        resolution: '分辨率',
        scene: '场景',
        image: '出图',
        cost: '预估费用',
        fill: '失败补位',
        durMinutes: '{mins} 分钟 = {clips} 段 × {sec} 秒',
        durSeconds: '{sec} 秒 = {clips} 段 × {sec} 秒',
        resolutionEditable: '{res}（下面可改）',
        sceneAuto: '场景卡库随机抽取 {n} 个不同场景（按章节顺序播映，不重复）',
        sceneOff: '自由提示词（已关闭场景卡）',
        imageOn: '逐段 {n} 张 → 图生视频',
        imageOff: '关（纯文生视频）',
        autoGrade: '出图调色',
        autoGradeOn: '自动（压回自然区间）',
        autoGradeOff: '不调（保留原图）',
        autoGradeToggle: '出图后自动调色',
        autoGradeSub: '（关闭则保留原图，可去图片库手动调色）',
        costRetry: '（重试上限 {cap}，最多 {n} 次）',
        costNoRetry: '（无重试预算）',
        fillMax: '最多 {n} 段（≤5% 且 ≤10 段）',
        resPickLabel: '分辨率',
        resTitle: '改成 {res}（重新出计划卡，不计费）',
        resNote: '点了重新出计划卡（不计费）',
        warningPrefix: '注意：{w}',
        imageToggle: '逐段出图',
        imageToggleSub: '（场景卡 → 首帧图 → 图生视频）',
        billingUnit: '出图 {n} 张 × {unit} ≈ {total}（图片真实计费，视频费用见「预估费用」；单价来自 /api/assistant/info）',
        billingUnknown: '出图 {n} 张 · 单价未知（服务端未返回 image.unitCny：先到「设置 → 图片生成」配好模型，或写 app/.env 的 IMAGE_GEN_MODEL 后重启服务）',
        pauseNote: '出图完成后整批暂停，等你审图后再点继续（不点就不会花视频的钱）。',
        oldServer: '⛔ 服务端还是旧进程（info 里没有 image 段）：逐段出图**不会生效**，确认会被拦下。请先重启 3001 再点确认，或关掉本开关走纯文生视频。',
        noImageKey: '设置里没有「图片生成」的 Key：现在确认会返回「出图未就绪」，不建任务、不扣费。',
        pureText: '纯文生视频（旧链路，不出图；行为与之前完全一致）。',
        submitBusy: '提交中…',
        confirmPaid: '确认执行（{cost}）',
        confirmFree: '确认执行（零计费）',
        paidNote: '付费任务：确认后才会调用模型',
        mockNote: 'Mock：不产生费用'
      },
      state: {
        draft: '草稿',
        planned: '计划已生成',
        confirmed: '已确认',
        submitted: '已提交',
        running: '生成中',
        retrying: '质检重试中',
        filling: '片段补位中',
        done: '已完成',
        failed: '失败',
        needs_user: '需要你决定',
        retry: '重试 {n}/{max}',
        fill: '补位 {n}/{max}',
        clips: '片段 {n}/{max}',
        awaiting: '等待审图',
        detail: '详情'
      },
      review: {
        title: '图已出好',
        paused: '已暂停，等你审图',
        summary: '共 {total} 段 · 出图 {generated} 张{failed} · 待审 {pending} 张',
        failedSuffix: '（失败 {n} 张）',
        guide: '到「库 · 图片」抽看 / 通过 / 打回；点「继续生成」才开始花视频的钱（未单独审核的按通过处理）。',
        failedNote: '有 {n} 张没出成：可以先回图片库重出，或直接继续（这些片段会判失败，不会降级成文生视频）。',
        goReview: '去审图',
        continueBusy: '继续中…',
        continue: '继续生成'
      },
      greeting: {
        title: '我是小智',
        body: '说个总时长，我来排计划，比如「10 分钟」。',
        closeAria: '关闭小智提示'
      },
      mic: {
        modalAria: '麦克风权限',
        kicker: 'MICROPHONE · 语音输入',
        titleGranted: '麦克风已允许',
        titleRequesting: '正在请求麦克风',
        titleFallback: '麦克风权限',
        bodyGranted: '现在按住麦克风说话，松开后会自动转成文字。',
        bodyRequesting: '请在弹出的浏览器授权提示里点「允许」。',
        errorLine: '浏览器错误：{name}{msg}',
        errorMsg: ' · {msg}',
        start: '开始说话',
        waiting: '等待允许…',
        retry: '重新请求麦克风',
        copied: '已复制',
        copy: '复制排查步骤',
        typeInstead: '先打字',
        note: '只授权一次，浏览器会记住；语音识别在本机离线完成。',
        statusTranscribing: '正在识别语音…',
        statusStarting: '正在打开麦克风… 请继续按住',
        statusRecording: '正在录音 {n} 秒 · 请说话，松开结束',
        btnAria: '按住说话',
        btnDisabledTitle: '服务端未重启，语音暂不可用',
        btnStopTitle: '松开结束',
        btnDeniedTitle: '麦克风被拒绝，点这里看怎么开',
        btnGrantedTitle: '按住说话',
        btnHoldTitle: '按住说话（首次需要允许麦克风）',
        failPrefix: '麦克风没有启动：{name}{denied}。已打开排查卡；也可以先打字。',
        deniedSuffix: '（授权被拒绝/未允许）',
        unknownError: '未知错误',
        copyCodePrefix: '设置地址：',
        err: {
          insecure: {
            title: '当前页面不是安全来源',
            body: 'Chrome 只允许 localhost 或 https 页面使用麦克风。请用 http://localhost:3001 打开；不要用局域网 IP 的 http 地址，也不要在别的应用的内嵌页里打开。',
            s1: '确认地址栏是 http://localhost:3001 或 https://…；',
            s2: '如果要从手机/别的机器访问，需要给站点配 HTTPS。'
          },
          unsupported: {
            title: '这个浏览器不支持录音',
            body: '当前浏览器没有可用的录音接口。建议改用最新版 Chrome / Edge 打开本页。',
            s1: '换 Chrome 或 Edge 最新版；',
            s2: '如果页面嵌在别的应用里，请复制地址到系统浏览器打开。'
          },
          notFound: {
            title: '没有检测到麦克风',
            body: '系统里没有可用的录音设备。插上/启用麦克风后点「重新请求麦克风」。',
            s1: 'Windows 声音设置里确认输入设备已启用；',
            s2: '笔记本确认没有把麦克风静音或禁用。'
          },
          busy: {
            title: '麦克风被其他程序占用了',
            body: '另一个程序正在独占麦克风。关掉它，再点「重新请求麦克风」。',
            s1: '关闭腾讯会议 / ToDesk / OBS / 录音软件等正在用麦克风的程序；',
            s2: '如果设备是虚拟声卡，切到系统默认麦克风再试。'
          },
          policy: {
            title: '站点已允许，但页面仍被禁止',
            body: 'Chrome 站点权限已经是「允许」，但本页面的 Permissions-Policy 或系统隐私仍在拦截麦克风。',
            s1: '确认服务端没有把该页面的 Permissions-Policy 设成 microphone=()；本仓库 server.js 应为 microphone=(self)。',
            s2: 'Windows：设置 → 隐私和安全性 → 麦克风 → 打开「允许桌面应用访问麦克风」。',
            s3: '改完刷新页面，再按住麦克风。'
          },
          denied: {
            title: '麦克风被浏览器拒绝了',
            body: 'Chrome 没把麦克风权限给这个页面。按下面几步改一次，之后按住麦克风就能说话：',
            s1: '点地址栏左侧的「⚙」或「🔒」图标 →「网站设置」→ 把「麦克风」改成「允许」。',
            s2: '或者新标签页打开 chrome://settings/content/microphone，把 localhost:3001 设为「允许」。',
            s3: 'Windows：设置 → 隐私和安全性 → 麦克风 → 打开「允许应用访问麦克风」和「允许桌面应用访问麦克风」。',
            s4: '回到本页刷新一次，再按住麦克风。'
          },
          generic: {
            title: '麦克风没有启动',
            body: '浏览器返回了错误：{name}。',
            s1: '确认麦克风没有被其他程序占用；',
            s2: '刷新页面再试；还不行就先用键盘打字。'
          }
        },
        hint: {
          browserUnavailable: '这台浏览器/这个页面暂时用不了麦克风；请改用打字。',
          allowedAgain: '麦克风已允许，请再按住麦克风说一次。',
          allowedNow: '麦克风已允许，现在按住麦克风说话就行。',
          noSound: '没录到声音，再按住说一次试试。',
          tooShort: '录音太短：按住后对着麦克风说，说完再松开。',
          tooQuiet: '没听到声音：按住后对着麦克风说话（离麦克风近一点），说完再松开。',
          asrFailed: '语音识别失败：{error}，请改用打字。',
          unclear: '没听清：只识别到标点/杂音。按住后对着麦克风说清楚，说完再松开。',
          uploadFailed: '语音上传异常：{error}，请改用打字。',
          copyFailed: '复制失败，请按弹窗里的步骤手动设置。'
        }
      }
    }
  },
  en: {
    xiaozhi: {
      plan: {
        cardTitle: 'XiaoZhi · Plan',
        sceneMode: 'Scene-card mode',
        freePrompt: 'Free prompt',
        edit: 'Edit',
        duration: 'Duration',
        theme: 'Theme',
        model: 'Model',
        resolution: 'Resolution',
        scene: 'Scenes',
        image: 'Images',
        cost: 'Estimated cost',
        fill: 'Fill-ins',
        durMinutes: '{mins} min = {clips} clips × {sec}s',
        durSeconds: '{sec}s = {clips} clips × {sec}s',
        resolutionEditable: '{res} (editable below)',
        sceneAuto: 'Randomly drawing {n} different scenes from the scene-card library (chapter order, no repeats)',
        sceneOff: 'Free prompt (scene cards off)',
        imageOn: '{n} images, one per clip → image-to-video',
        imageOff: 'Off (text-to-video)',
        autoGrade: 'Image grading',
        autoGradeOn: 'auto (natural range)',
        autoGradeOff: 'off (keep original)',
        autoGradeToggle: 'Auto-adjust generated images',
        autoGradeSub: ' (off keeps the original; adjust manually in the library)',
        costRetry: ' (retry cap {cap}, up to {n} retries)',
        costNoRetry: ' (no retry budget)',
        fillMax: 'Up to {n} clips (≤5% and ≤10 clips)',
        resPickLabel: 'Resolution',
        resTitle: 'Change to {res} (rebuilds the plan card; no charge)',
        resNote: 'Clicking rebuilds the plan card (no charge)',
        warningPrefix: 'Note: {w}',
        imageToggle: 'Image per clip',
        imageToggleSub: ' (scene card → first-frame image → image-to-video)',
        billingUnit: '{n} images × {unit} ≈ {total} (images are billed; video cost is under "Estimated cost"; unit price from /api/assistant/info)',
        billingUnknown: '{n} images · unit price unknown (the server did not return image.unitCny: configure the model in Settings → Image generation, or set IMAGE_GEN_MODEL in app/.env and restart)',
        pauseNote: 'The batch pauses after images are generated; review them and click Continue (video charges start only after that).',
        oldServer: '⛔ The server is still an old process (no image section in info): "image per clip" will NOT take effect and confirmation is blocked. Restart 3001 first, or turn this off to use text-to-video.',
        noImageKey: 'No image-generation key is configured: confirming now returns "image generation not ready"; no task is created and nothing is charged.',
        pureText: 'Text-to-video only (legacy path, no images; behavior is unchanged).',
        submitBusy: 'Submitting…',
        confirmPaid: 'Confirm ({cost})',
        confirmFree: 'Confirm (free)',
        paidNote: 'Paid task: models are called only after confirmation',
        mockNote: 'Mock: no charge'
      },
      state: {
        draft: 'Draft',
        planned: 'Plan ready',
        confirmed: 'Confirmed',
        submitted: 'Submitted',
        running: 'Generating',
        retrying: 'Retrying (QC)',
        filling: 'Filling failed clips',
        done: 'Completed',
        failed: 'Failed',
        needs_user: 'Needs your decision',
        retry: 'Retry {n}/{max}',
        fill: 'Fill {n}/{max}',
        clips: 'Clips {n}/{max}',
        awaiting: 'Awaiting review',
        detail: 'Details'
      },
      review: {
        title: 'Images ready',
        paused: 'Paused for your review',
        summary: '{total} clips · {generated} images{failed} · {pending} pending review',
        failedSuffix: ' ({n} failed)',
        guide: 'Open Library → Photos to sample / approve / reject; video charges start only after "Continue" (images without individual review are treated as approved).',
        failedNote: '{n} images failed: regenerate them in the photo library, or continue directly (those clips will be marked failed, not downgraded to text-to-video).',
        goReview: 'Review images',
        continueBusy: 'Continuing…',
        continue: 'Continue'
      },
      greeting: {
        title: 'I am XiaoZhi',
        body: 'Tell me the total duration and I will lay out a plan, e.g. "10 minutes".',
        closeAria: 'Close XiaoZhi hint'
      },
      mic: {
        modalAria: 'Microphone permission',
        kicker: 'MICROPHONE · VOICE INPUT',
        titleGranted: 'Microphone allowed',
        titleRequesting: 'Requesting microphone',
        titleFallback: 'Microphone permission',
        bodyGranted: 'Hold the microphone and speak; release to transcribe.',
        bodyRequesting: 'Click "Allow" in the browser permission prompt.',
        errorLine: 'Browser error: {name}{msg}',
        errorMsg: ' · {msg}',
        start: 'Start talking',
        waiting: 'Waiting for permission…',
        retry: 'Request microphone again',
        copied: 'Copied',
        copy: 'Copy troubleshooting steps',
        typeInstead: 'Type instead',
        note: 'You only authorize once; the browser remembers it. Speech recognition runs locally offline.',
        statusTranscribing: 'Transcribing…',
        statusStarting: 'Opening the microphone… keep holding',
        statusRecording: 'Recording {n}s · speak, release to finish',
        btnAria: 'Hold to talk',
        btnDisabledTitle: 'The server has not restarted; voice is unavailable',
        btnStopTitle: 'Release to finish',
        btnDeniedTitle: 'Microphone denied; click to see how to enable it',
        btnGrantedTitle: 'Hold to talk',
        btnHoldTitle: 'Hold to talk (permission required the first time)',
        failPrefix: 'Microphone did not start: {name}{denied}. A troubleshooting card was opened; you can also type.',
        deniedSuffix: ' (permission denied/not allowed)',
        unknownError: 'unknown error',
        copyCodePrefix: 'Settings URL: ',
        err: {
          insecure: {
            title: 'This page is not a secure context',
            body: 'Chrome only allows microphone access on localhost or https. Open http://localhost:3001; do not use a LAN IP over http, and do not open it inside another app\'s embedded page.',
            s1: 'Check that the address bar shows http://localhost:3001 or https://…;',
            s2: 'To access from a phone or another machine, the site needs HTTPS.'
          },
          unsupported: {
            title: 'This browser does not support recording',
            body: 'This browser has no usable recording API. Open this page in a recent Chrome or Edge.',
            s1: 'Use the latest Chrome or Edge;',
            s2: 'If the page is embedded in another app, copy the address into a system browser.'
          },
          notFound: {
            title: 'No microphone detected',
            body: 'No recording device is available. Plug in / enable a microphone, then click "Request microphone again".',
            s1: 'Check that the input device is enabled in Windows sound settings;',
            s2: 'On a laptop, make sure the microphone is not muted or disabled.'
          },
          busy: {
            title: 'The microphone is used by another app',
            body: 'Another application is holding the microphone exclusively. Close it, then click "Request microphone again".',
            s1: 'Close apps that use the microphone (Tencent Meeting / ToDesk / OBS / recorders);',
            s2: 'If the device is a virtual audio card, switch to the system default microphone and retry.'
          },
          policy: {
            title: 'Site allowed, but the page is still blocked',
            body: 'Chrome site permission is already "Allow", but this page\'s Permissions-Policy or system privacy still blocks the microphone.',
            s1: 'Make sure the server does not set Permissions-Policy microphone=() for this page; this repo\'s server.js uses microphone=(self).',
            s2: 'Windows: Settings → Privacy & security → Microphone → enable "Let desktop apps access your microphone".',
            s3: 'Refresh the page and hold the microphone again.'
          },
          denied: {
            title: 'The browser denied the microphone',
            body: 'Chrome did not grant microphone permission to this page. Follow these steps once, then hold the microphone to talk:',
            s1: 'Click the "⚙" or "🔒" icon left of the address bar → Site settings → set Microphone to "Allow".',
            s2: 'Or open chrome://settings/content/microphone in a new tab and set localhost:3001 to "Allow".',
            s3: 'Windows: Settings → Privacy & security → Microphone → enable "Let apps access your microphone" and "Let desktop apps access your microphone".',
            s4: 'Return to this page, refresh once, then hold the microphone.'
          },
          generic: {
            title: 'Microphone did not start',
            body: 'The browser returned an error: {name}.',
            s1: 'Check that no other app is using the microphone;',
            s2: 'Refresh the page and retry; if it still fails, type instead.'
          }
        },
        hint: {
          browserUnavailable: 'This browser/page cannot use the microphone right now; please type instead.',
          allowedAgain: 'Microphone allowed; hold it and speak again.',
          allowedNow: 'Microphone allowed; hold it and speak.',
          noSound: 'No audio was recorded; hold and speak again.',
          tooShort: 'Recording too short: hold, speak into the microphone, then release.',
          tooQuiet: 'No sound detected: hold and speak closer to the microphone, then release.',
          asrFailed: 'Speech recognition failed: {error}. Please type instead.',
          unclear: 'Not clear: only punctuation/noise was recognized. Hold and speak clearly, then release.',
          uploadFailed: 'Voice upload failed: {error}. Please type instead.',
          copyFailed: 'Copy failed; follow the steps in the dialog manually.'
        }
      }
    }
  }
};
