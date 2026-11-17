// ============================================================
// i18n · 剪辑台（/app/edit）
// 素材栏 / 预览 / 调节（基础+HSL/曲线/色轮）/ 时间线 / 工程弹窗
// ============================================================
export default {
  zh: {
    studio: {
      save: {
        saving: '保存中…',
        saved: '已保存',
        conflict: '已被其他窗口修改',
        error: '保存失败'
      },
      adjust: {
        groups: { color: '色彩', light: '明度' },
        labels: {
          temperature: '色温', tone: '色调', saturation: '饱和度',
          brightness: '亮度', contrast: '对比度', highlight: '高光',
          shadow: '阴影', white: '白色', black: '黑色', lightSensation: '光感'
        },
        tabs: {
          basic: '基础', hsl: 'HSL', curve: '曲线', wheel: '色轮',
          basicTitle: '基础调节', hslTitle: 'HSL 8 个色带',
          curveTitle: 'RGB 曲线', wheelTitle: 'lift / gamma / gain 色轮'
        }
      },
      sources: {
        clip: '片段', final: '成片', photo: '图片',
        task: '任务', library: '片段库', editor: '剪辑台导出', orphan: '孤儿成片'
      },
      photoStatus: { pending: '待审', approved: '通过', rejected: '打回' },
      defaultProjectName: '未命名工程',
      errors: {
        loadProject: '工程加载失败',
        webgl: 'WebGL 初始化失败',
        library: '素材加载失败',
        photos: '图片加载失败',
        save: '保存失败',
        export: '导出失败',
        exportStatus: '查询导出状态失败：',
        list: '读取工程列表失败：',
        rebuild: '重建失败：',
        open: '打开失败：',
        create: '新建失败：',
        fullscreen: '当前浏览器不支持全屏'
      },
      toasts: {
        photoDeferred: '图片素材首版暂不能加入时间线（产品已定后置）',
        loadedWhole: '已整段载入成片：',
        addedTimeline: '已加入时间线：',
        audioSplit: '音频轨暂不支持分割（请用左侧入点/出点）',
        tooShort: '片段太短，无法分割',
        needAsset: '先加素材再导出',
        exportDone: '导出完成，已归入「库 · 成片」',
        rebuildDone: '已从成片重建工程：',
        selectMusic: '已选中音乐轨：',
        selectAmbient: '已选中环境音轨：'
      },
      fatal: {
        title: '剪辑台加载失败',
        retry: '重试',
        opening: '正在打开剪辑台…'
      },
      header: {
        backTitle: '返回小智',
        brand: '剪辑台',
        nameAria: '工程名',
        open: '打开',
        create: '新建',
        exportTitle: '导出为成片',
        exporting: '导出中 {n}%',
        export: '导出',
        viewFinal: '看成片'
      },
      rail: { media: '素材', audio: '音频' },
      panel: {
        media: '素材',
        audio: '音频',
        photoCount: '{n} 张',
        clipRatio: '{shown} / {total} 段',
        musicAmbient: '音乐 / 环境音',
        sourcesAria: '素材来源',
        searchPlaceholder: '搜索提示词 / 模型 / 分辨率',
        mediaLoading: '素材加载中…',
        photosLoading: '图片加载中…',
        photoDeferredNote: '图片素材首版后置：暂不能加入时间线（产品已定）。',
        photoTitleSuffix: ' · 图片（首版后置）',
        photoBadge: '图片',
        photoMeta: '{model} · 图片',
        photoEmpty: '图片库为空',
        finalNote: '成片默认整段载入，可在时间线拖手柄裁入/出点。',
        cardTitleFinal: ' · 点击整段载入成片',
        cardTitleClip: ' · 点击加入时间线',
        finalBadge: '成片',
        originFinal: '成片',
        finalEmpty: '成片库为空（导出一次后出现在这里）',
        clipEmpty: '片段库为空',
        only120: '只显示前 120 条，用搜索缩小范围'
      },
      preview: {
        frameTitle: '双击放大/还原',
        emptyTitle: '时间线为空',
        emptyHint: '左侧选素材 → 加入时间线 → 右侧调节 → 导出',
        pause: '暂停',
        play: '播放',
        theaterTitle: '隐藏两侧面板，放大预览',
        restore: '还原',
        enlarge: '放大',
        fullscreenTitle: '全屏预览（Esc 退出）',
        fullscreen: '全屏'
      },
      inspector: {
        transition: '转场',
        transitionToggle: '片段之间淡入淡出',
        duration: '时长',
        type: '类型',
        types: {
          fade: '淡化', dissolve: '溶解', wipeleft: '左擦除', wiperight: '右擦除',
          slideleft: '左滑动', slideright: '右滑动', circleopen: '圆形展开', pixelize: '像素化'
        },
        transitionHint: '关闭后走直拼（不叠化，不缩短时长）；预览与导出同时生效。',
        selectFirst: '先在时间线选中一个片段',
        basicEmptyHint: '选中谁，调谁；每段参数独立保存',
        tabEmptyHint: '选中片段后调整「{tab}」',
        resetSegment: '重置本段',
        basicHint: '参数保存到工程草稿；导出时按段烘成 LUT（与预览同一套颜色数学）。'
      },
      timeline: {
        undo: '撤销', redo: '重做', split: '分割', delete: '删除',
        splitTitle: '在播放头分割', deleteTitle: '删除选中片段/音轨',
        zoom: '缩放',
        count: '{n} 段 · {time}',
        video: '视频', audio: '音频',
        empty: '从左侧点选或拖入素材',
        trimIn: '拖动裁剪入点', trimOut: '拖动裁剪出点',
        audioEmpty: '音乐 / 环境音（左侧音频面板）',
        playhead: '拖动定位'
      },
      projects: {
        openTitle: '打开工程',
        close: '关闭',
        noProjects: '还没有工程',
        segmentCount: '{n} 段 · {time}',
        rebuildSub: '已完成成片 · 重建为工程',
        loadingFilms: '读取成片…',
        noFilms: '还没有已完成成片',
        filmMeta: '{n} 段 · {time}',
        partial: ' · 部分',
        recent20: '只显示最近 20 条'
      },
      viewer: {
        title: '成片预览',
        close: '关闭（Esc）',
        savedNote: '成片已保存在 output/ 并归入「库 · 成片」',
        newTab: '新标签打开'
      }
    }
  },
  en: {
    studio: {
      save: {
        saving: 'Saving…',
        saved: 'Saved',
        conflict: 'Changed in another window',
        error: 'Save failed'
      },
      adjust: {
        groups: { color: 'Color', light: 'Lightness' },
        labels: {
          temperature: 'Temperature', tone: 'Tone', saturation: 'Saturation',
          brightness: 'Brightness', contrast: 'Contrast', highlight: 'Highlights',
          shadow: 'Shadows', white: 'Whites', black: 'Blacks', lightSensation: 'Light feel'
        },
        tabs: {
          basic: 'Basic', hsl: 'HSL', curve: 'Curves', wheel: 'Wheels',
          basicTitle: 'Basic adjustment', hslTitle: 'HSL · 8 bands',
          curveTitle: 'RGB curves', wheelTitle: 'lift / gamma / gain wheels'
        }
      },
      sources: {
        clip: 'Clips', final: 'Finals', photo: 'Photos',
        task: 'Task', library: 'Clip library', editor: 'Editor export', orphan: 'Orphan final'
      },
      photoStatus: { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' },
      defaultProjectName: 'Untitled project',
      errors: {
        loadProject: 'Failed to load the project',
        webgl: 'WebGL initialization failed',
        library: 'Failed to load assets',
        photos: 'Failed to load photos',
        save: 'Save failed',
        export: 'Export failed',
        exportStatus: 'Failed to check export status: ',
        list: 'Failed to load projects: ',
        rebuild: 'Rebuild failed: ',
        open: 'Open failed: ',
        create: 'Create failed: ',
        fullscreen: 'Fullscreen is not supported in this browser'
      },
      toasts: {
        photoDeferred: 'Photos cannot be added to the timeline yet (deferred by product decision)',
        loadedWhole: 'Loaded the whole final: ',
        addedTimeline: 'Added to timeline: ',
        audioSplit: 'Splitting an audio track is not supported yet (use in/out points on the left)',
        tooShort: 'Clip is too short to split',
        needAsset: 'Add an asset before exporting',
        exportDone: 'Export complete; added to Library → Finals',
        rebuildDone: 'Rebuilt project from final: ',
        selectMusic: 'Music track selected: ',
        selectAmbient: 'Ambient track selected: '
      },
      fatal: {
        title: 'Failed to load the editor',
        retry: 'Retry',
        opening: 'Opening the editor…'
      },
      header: {
        backTitle: 'Back to XiaoZhi',
        brand: 'Editor',
        nameAria: 'Project name',
        open: 'Open',
        create: 'New',
        exportTitle: 'Export as a final',
        exporting: 'Exporting {n}%',
        export: 'Export',
        viewFinal: 'View final'
      },
      rail: { media: 'Media', audio: 'Audio' },
      panel: {
        media: 'Media',
        audio: 'Audio',
        photoCount: '{n} photos',
        clipRatio: '{shown} / {total} clips',
        musicAmbient: 'Music / Ambient',
        sourcesAria: 'Media source',
        searchPlaceholder: 'Search prompts / models / resolutions',
        mediaLoading: 'Loading assets…',
        photosLoading: 'Loading photos…',
        photoDeferredNote: 'Photos are deferred: they cannot be added to the timeline yet (product decision).',
        photoTitleSuffix: ' · photo (deferred)',
        photoBadge: 'Photo',
        photoMeta: '{model} · photo',
        photoEmpty: 'The photo library is empty',
        finalNote: 'Finals load as a whole; drag the handles on the timeline to trim in/out.',
        cardTitleFinal: ' · click to load the whole final',
        cardTitleClip: ' · click to add to the timeline',
        finalBadge: 'Final',
        originFinal: 'Final',
        finalEmpty: 'The finals library is empty (it appears here after one export)',
        clipEmpty: 'The clip library is empty',
        only120: 'Showing the first 120; narrow it down with search'
      },
      preview: {
        frameTitle: 'Double-click to enlarge/restore',
        emptyTitle: 'Timeline is empty',
        emptyHint: 'Pick media on the left → add to the timeline → adjust on the right → export',
        pause: 'Pause',
        play: 'Play',
        theaterTitle: 'Hide both panels and enlarge the preview',
        restore: 'Restore',
        enlarge: 'Enlarge',
        fullscreenTitle: 'Fullscreen preview (Esc to exit)',
        fullscreen: 'Fullscreen'
      },
      inspector: {
        transition: 'Transition',
        transitionToggle: 'Fade between clips',
        duration: 'Duration',
        type: 'Type',
        types: {
          fade: 'Fade', dissolve: 'Dissolve', wipeleft: 'Wipe left', wiperight: 'Wipe right',
          slideleft: 'Slide left', slideright: 'Slide right', circleopen: 'Circle open', pixelize: 'Pixelize'
        },
        transitionHint: 'Off means a hard cut (no dissolve, no shortened duration); applies to preview and export.',
        selectFirst: 'Select a clip on the timeline first',
        basicEmptyHint: 'Adjust whatever is selected; each clip keeps its own values',
        tabEmptyHint: 'Select a clip to adjust "{tab}"',
        resetSegment: 'Reset this clip',
        basicHint: 'Values are saved in the project draft; export bakes them into a per-clip LUT (same color math as the preview).'
      },
      timeline: {
        undo: 'Undo', redo: 'Redo', split: 'Split', delete: 'Delete',
        splitTitle: 'Split at the playhead', deleteTitle: 'Delete the selected clip/audio',
        zoom: 'Zoom',
        count: '{n} clips · {time}',
        video: 'Video', audio: 'Audio',
        empty: 'Pick or drag media from the left',
        trimIn: 'Drag to trim the in point', trimOut: 'Drag to trim the out point',
        audioEmpty: 'Music / ambient (audio panel on the left)',
        playhead: 'Drag to seek'
      },
      projects: {
        openTitle: 'Open project',
        close: 'Close',
        noProjects: 'No projects yet',
        segmentCount: '{n} clips · {time}',
        rebuildSub: 'Completed finals · rebuild as a project',
        loadingFilms: 'Loading finals…',
        noFilms: 'No completed finals yet',
        filmMeta: '{n} clips · {time}',
        partial: ' · partial',
        recent20: 'Showing the 20 most recent'
      },
      viewer: {
        title: 'Final preview',
        close: 'Close (Esc)',
        savedNote: 'The final is saved in output/ and added to Library → Finals',
        newTab: 'Open in a new tab'
      }
    }
  }
};
