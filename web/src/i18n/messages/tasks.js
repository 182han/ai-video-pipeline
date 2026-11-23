// ============================================================
// i18n · 任务条 / 暂停控制 / 任务详情抽屉
// 键分组：tasks.status / tasks.note / tasks.pause / tasks.step /
//        tasks.job / tasks.drawer / tasks.qc / tasks.colorMatch / tasks.adjust
// ============================================================
export default {
  zh: {
    tasks: {
      displayName: '{prompt} · {model} · {time}',
      displayNameNoPrompt: '{model} · {time}',
      displayNameUnnamed: '未命名任务 {id}',
      shortId: 'ID {id}',
      taskIdTooltip: '完整任务 ID：{id}',
      status: {
        completed: '已完成',
        generating: '生成中',
        paused: '已暂停',
        partial: '部分完成',
        pending: '等待中',
        failed: '失败',
        abortedResumable: '已中止 · 可补跑'
      },
      note: {
        pauseTimeout: '暂停等待超过上限，任务被中止（不是生成失败）',
        pauseInterrupted: '暂停期间服务重启，已降级为失败，可补跑从断点继续'
      },
      pause: {
        pause: '暂停',
        resume: '继续',
        pauseTitle: '当前片段跑完后停止，不再发起新的付费生成',
        resumeTitle: '从断点继续',
        failed: '操作失败'
      },
      step: {
        prompt_optimize: '提示词优化',
        storyboard: '分镜拆解',
        clip_generation: '视频生成',
        concatenation: '拼接',
        loop_processing: '循环',
        audio_mix: '配乐',
        transcoding: '转码',
        final_qc: '质检'
      },
      job: {
        noPrompt: '(无提示词)',
        viewProgress: '查看进度'
      },
      drawer: {
        title: '任务详情',
        taskId: '任务 ID',
        close: '关闭',
        loading: '加载中…',
        loadFailed: '读取失败：',
        noPrompt: '(无提示词)',
        expandPrompts: '展开 {n} 条分镜提示词',
        preset: '档位',
        model: '模型',
        resolution: '分辨率',
        clips: '片段',
        finalDuration: '成片时长',
        created: '创建',
        error: '错误',
        aborted: '中止',
        resumable: '可补跑',
        retry: '重试',
        continueWithClips: '用已成功片段继续',
        continueTask: '补跑',
        noKeyConfirm: '浏览器里没有找到这个通道的 Key；继续会降级成 Mock 合成画面（不消耗真实额度，但不是你要的成片）。仍要继续吗？',
        downloadFinal: '下载成片',
        openInEditor: '在剪辑台打开',
        failedClips: '失败片段（{n}）',
        failedClipsHint: '只重生成你点的那一条；不会自动重跑其它片段。',
        failedBadge: '生成/质检未通过',
        regenerating: '重生成中…',
        regenerate: '重新生成',
        colorMatch: '校色',
        userRequest: '用户要求',
        enabled: '开启',
        notRequested: '未要求（默认关）',
        maxGain: ' · 增益上限 {value}',
        actualResult: '实际结果',
        adjustments: '调节',
        noAdjustments: '未调节',
        appliedOnExport: '导出时已应用：{list}',
        adjustmentsSaved: '参数已保存，尚未应用到成片',
        actionFailed: '操作失败',
        regenerateFailed: '重生成失败',
        pipeline: '流水线'
      },
      qc: {
        notRun: '未执行',
        passed: '通过',
        plannedSkip: '按计划跳过',
        skippedUnknown: '跳过·不可判',
        failed: '不通过'
      },
      colorMatch: {
        noResult: '没有拿到校色结果字段',
        applied: '已校色',
        appliedCount: '已校色 {applied}/{total} 段',
        lutCount: '{n} 组 LUT',
        disabled: '未校色',
        disabledTitle: '默认关闭，本次未开启',
        skipped: '校色未执行',
        skippedTitle: '按设计跳过',
        failed: '校色失败',
        failedTitle: '（成片仍按原片产出，不是出片失败）'
      },
      adjust: {
        temperature: '色温',
        tone: '色调',
        saturation: '饱和度',
        brightness: '亮度',
        contrast: '对比度',
        highlight: '高光',
        shadow: '阴影',
        white: '白色',
        black: '黑色',
        lightSensation: '光感'
      }
    }
  },
  en: {
    tasks: {
      displayName: '{prompt} · {model} · {time}',
      displayNameNoPrompt: '{model} · {time}',
      displayNameUnnamed: 'Untitled task {id}',
      shortId: 'ID {id}',
      taskIdTooltip: 'Full task ID: {id}',
      status: {
        completed: 'Completed',
        generating: 'Generating',
        paused: 'Paused',
        partial: 'Partially completed',
        pending: 'Waiting',
        failed: 'Failed',
        abortedResumable: 'Aborted · resumable'
      },
      note: {
        pauseTimeout: 'Pause wait exceeded the limit, so the task was aborted (this is not a generation failure).',
        pauseInterrupted: 'The service restarted during the pause; the task was downgraded to failed and can be resumed from the checkpoint.'
      },
      pause: {
        pause: 'Pause',
        resume: 'Resume',
        pauseTitle: 'Stops after the current clip; no new paid generations are started.',
        resumeTitle: 'Resume from the checkpoint',
        failed: 'Action failed'
      },
      step: {
        prompt_optimize: 'Prompt optimization',
        storyboard: 'Storyboard',
        clip_generation: 'Video generation',
        concatenation: 'Concatenation',
        loop_processing: 'Loop',
        audio_mix: 'Soundtrack',
        transcoding: 'Transcoding',
        final_qc: 'QC'
      },
      job: {
        noPrompt: '(no prompt)',
        viewProgress: 'View progress'
      },
      drawer: {
        title: 'Task details',
        taskId: 'Task ID',
        close: 'Close',
        loading: 'Loading…',
        loadFailed: 'Failed to load: ',
        noPrompt: '(no prompt)',
        expandPrompts: 'Show {n} shot prompts',
        preset: 'Preset',
        model: 'Model',
        resolution: 'Resolution',
        clips: 'Clips',
        finalDuration: 'Final duration',
        created: 'Created',
        error: 'Error',
        aborted: 'Aborted',
        resumable: 'resumable',
        retry: 'Retry',
        continueWithClips: 'Continue with successful clips',
        continueTask: 'Continue',
        noKeyConfirm: 'No API key for this channel was found in the browser. Continuing would silently fall back to Mock footage (it does not spend real credit, but it is not the video you want). Continue anyway?',
        downloadFinal: 'Download final',
        openInEditor: 'Open in editor',
        failedClips: 'Failed clips ({n})',
        failedClipsHint: 'Only the clip you click is regenerated; other clips are not rerun.',
        failedBadge: 'Generation/QC not passed',
        regenerating: 'Regenerating…',
        regenerate: 'Regenerate',
        colorMatch: 'Color match',
        userRequest: 'Requested',
        enabled: 'On',
        notRequested: 'Not requested (off by default)',
        maxGain: ' · max gain {value}',
        actualResult: 'Result',
        adjustments: 'Adjustments',
        noAdjustments: 'No adjustments',
        appliedOnExport: 'Applied on export: {list}',
        adjustmentsSaved: 'Parameters saved; not yet applied to the final video.',
        actionFailed: 'Action failed',
        regenerateFailed: 'Regeneration failed',
        pipeline: 'Pipeline'
      },
      qc: {
        notRun: 'Not run',
        passed: 'Passed',
        plannedSkip: 'Skipped as planned',
        skippedUnknown: 'Skipped · undetermined',
        failed: 'Failed'
      },
      colorMatch: {
        noResult: 'No color-match result field',
        applied: 'Color matched',
        appliedCount: 'Color matched {applied}/{total} clips',
        lutCount: '{n} LUTs',
        disabled: 'Not color matched',
        disabledTitle: 'Off by default; not enabled this run',
        skipped: 'Color match not run',
        skippedTitle: 'Skipped by design',
        failed: 'Color match failed',
        failedTitle: ' (the final video is still produced from the original clips; this is not an export failure)'
      },
      adjust: {
        temperature: 'Temperature',
        tone: 'Tone',
        saturation: 'Saturation',
        brightness: 'Brightness',
        contrast: 'Contrast',
        highlight: 'Highlights',
        shadow: 'Shadows',
        white: 'Whites',
        black: 'Blacks',
        lightSensation: 'Light feel'
      }
    }
  }
};
