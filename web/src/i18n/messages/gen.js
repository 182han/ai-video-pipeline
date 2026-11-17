// ============================================================
// i18n · 生成中页面
// 键分组：gen.*（步骤名复用 tasks.step.*）
// ============================================================
export default {
  zh: {
    gen: {
      noTask: '当前没有进行中的任务',
      goCreate: '去创作',
      title: {
        completed: '已完成',
        failed: '已结束',
        generating: '正在生成'
      },
      exit: '退出观看',
      spent: ' · 已花 ¥{amount}',
      resumable: ' · 可补跑',
      stepState: {
        done: '完成',
        paused: '已暂停',
        running: '进行中',
        waiting: '等待'
      },
      progress: '已完成 {done} / {total} 个环节',
      openLibrary: '去库看成片'
    }
  },
  en: {
    gen: {
      noTask: 'No task in progress',
      goCreate: 'Create',
      title: {
        completed: 'Completed',
        failed: 'Ended',
        generating: 'Generating'
      },
      exit: 'Exit preview',
      spent: ' · Spent ¥{amount}',
      resumable: ' · resumable',
      stepState: {
        done: 'Done',
        paused: 'Paused',
        running: 'Running',
        waiting: 'Waiting'
      },
      progress: '{done} / {total} steps completed',
      openLibrary: 'Open library'
    }
  }
};
