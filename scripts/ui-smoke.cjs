const { app, BrowserWindow, ipcMain } = require('electron')
const { mkdirSync } = require('fs')
const { join } = require('path')
const { pathToFileURL } = require('url')

const testUserData = join(__dirname, '..', 'out', 'test', 'electron-user-data')
mkdirSync(testUserData, { recursive: true })
app.setPath('userData', testUserData)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('no-sandbox')

const now = Date.now()
const correctionItems = Array.from({ length: 16 }, (_, index) => ({
  id: `ui-correction-${index}`,
  original:
    index === 0
      ? 'I very like this movie'
      : `I very like this movie ${index}`,
  corrected:
    index === 0
      ? 'I like this movie very much'
      : `I like this movie ${index} very much`,
  type: index % 3 === 0 ? 'expression' : 'grammar',
  scope: index % 3 === 0 ? 'sentence' : 'span',
  sentenceIndex: index,
  explanation: '这是用于验证长纠错列表内部滚动的中文解释。'
}))
const vocabularyItems = Array.from({ length: 18 }, (_, index) => ({
  id: `ui-vocabulary-${index}`,
  term: index === 0 ? 'compelling' : `keyword ${index}`,
  normalizedTerm: index === 0 ? 'compelling' : `keyword ${index}`,
  partOfSpeech: index % 2 === 0 ? '形容词' : '固定搭配',
  chineseMeaning: index === 0 ? '引人入胜的' : `关键词释义 ${index}`,
  sourceSentence:
    index === 0
      ? 'The story is compelling, and the main character grows throughout the movie.'
      : `This is the source sentence for keyword ${index}.`
}))
vocabularyItems.push({
  id: 'ui-vocabulary-duplicate',
  term: 'Compelling',
  normalizedTerm: 'compelling',
  partOfSpeech: '形容词',
  chineseMeaning: '引人入胜的',
  sourceSentence: 'The story is compelling.'
})
const conversation = {
  id: 'ui-smoke-conversation',
  title: 'A conversation about movies',
  practiceMode: 'free',
  preview: 'I really enjoyed the movie.',
  messageCount: 6,
  contentRevision: 6,
  analysisRevision: 2,
  createdAt: now,
  updatedAt: now,
  lastOpenedAt: now,
  contextSummary: '',
  summaryThroughSequence: 0,
  contextPromptVersion: 1,
  hasEarlierMessages: false,
  messages: [
    {
      id: 'ui-user',
      conversationId: 'ui-smoke-conversation',
      sequence: 1,
      role: 'user',
      content: 'I very like this movie because the story is exciting.',
      timestamp: now - 1000,
      inputMode: 'voice',
      status: 'complete',
      corrections: correctionItems
    },
    {
      id: 'ui-assistant',
      conversationId: 'ui-smoke-conversation',
      sequence: 2,
      role: 'assistant',
      content: '<think>This internal reasoning must stay hidden.</think> **I agree.** The story is compelling, and the main character can’t leave 😊.',
      timestamp: now,
      inputMode: 'text',
      status: 'complete',
      replyToMessageId: 'ui-user',
      vocabulary: vocabularyItems
    },
    {
      id: 'ui-user-analysis-failed',
      conversationId: 'ui-smoke-conversation',
      sequence: 3,
      role: 'user',
      content: 'The demon is a very cruel and handsome vampire.',
      timestamp: now + 1000,
      inputMode: 'voice',
      status: 'complete',
      correctionStatus: 'failed'
    },
    {
      id: 'ui-assistant-analysis-failed',
      conversationId: 'ui-smoke-conversation',
      sequence: 4,
      role: 'assistant',
      content: 'Damon is charming but dangerous, which makes him interesting to watch.',
      timestamp: now + 2000,
      inputMode: 'text',
      status: 'complete',
      replyToMessageId: 'ui-user-analysis-failed',
      vocabularyStatus: 'failed'
    },
    {
      id: 'ui-user-analysis-empty',
      conversationId: 'ui-smoke-conversation',
      sequence: 5,
      role: 'user',
      content: 'Damon is my favorite character.',
      timestamp: now + 3000,
      inputMode: 'voice',
      status: 'complete',
      correctionStatus: 'complete',
      corrections: []
    },
    {
      id: 'ui-assistant-analysis-empty',
      conversationId: 'ui-smoke-conversation',
      sequence: 6,
      role: 'assistant',
      content: 'I can understand why you like him.',
      timestamp: now + 4000,
      inputMode: 'text',
      status: 'complete',
      replyToMessageId: 'ui-user-analysis-empty',
      vocabularyStatus: 'complete',
      vocabulary: []
    }
  ]
}

function handle(channel, value) {
  ipcMain.handle(channel, () =>
    typeof value === 'function' ? value() : value
  )
}

handle('conversation:list', {
  items: [conversation],
  nextCursor: undefined
})
handle('conversation:getActive', conversation)
handle('conversation:get', conversation)
handle('conversation:getMessages', { messages: [], hasEarlierMessages: false })
handle('conversation:setActive', conversation)
handle('conversation:listDeleted', [])
handle('database:getStatus', {
  ready: true,
  path: 'C:\\mock\\learning.db'
})
handle('review:get', {
  conversation,
  review: {
    id: 'ui-review',
    conversationId: conversation.id,
    sourceContentRevision: conversation.contentRevision,
    sourceAnalysisRevision: conversation.analysisRevision,
    promptVersion: 2,
    status: 'ready',
    stale: false,
    summary: '这次会话围绕电影展开，用户能够清楚说明自己的喜好。',
    topics: ['电影'],
    strengths: ['主动说明原因'],
    priorities: ['练习程度副词的位置'],
    expressions: [{
      id: 'ui-expression',
      sourceUserMessageId: 'ui-user',
      original: 'I very like this movie',
      improved: 'I like this movie very much.',
      explanation: '把 very much 放在句末更自然。'
    }],
    selectedCorrections: correctionItems.map((item) => ({
      correctionId: item.id,
      reason: '这是口语中常见且值得优先修正的表达。',
      correctedMeaning: '我非常喜欢这部电影。'
    })),
    generatedAt: now
  }
})
handle('review:dashboard', {
  dueCount: 3,
  newCount: 2,
  masteredCount: 4,
  totalCount: 9,
  reviewedToday: 1,
  streakDays: 2,
  estimatedMinutes: 1,
  items: [{
    id: 'ui-review-item',
    kind: 'vocabulary',
    conversationId: conversation.id,
    sourceMessageId: 'ui-assistant',
    prompt: '“compelling” 的中文意思是什么？',
    answer: 'compelling',
    explanation: '形容词',
    meaning: '引人入胜的，极具吸引力的',
    sourceSentence: 'It is a compelling story.',
    dueAt: now,
    intervalDays: 0,
    repetitions: 0,
    lapses: 0,
    status: 'learning',
    createdAt: now,
    updatedAt: now
  }]
})
handle('review:evaluateAnswer', {
  level: 'strong',
  score: 92,
  feedback: '表达清楚自然。',
  strengths: ['成功使用目标表达'],
  improvements: [],
  suggestedGrade: 'good'
})
handle('review:grade', undefined)
handle('review:listLibrary', [])
handle('review:setMastered', undefined)
handle('review:deleteItem', undefined)
handle('llm:configure', undefined)
handle('llm:getProfiles', undefined)
handle('llm:saveProfiles', undefined)
handle('llm:correct', [])
handle('llm:vocabulary', [])
handle('llm:getDiagnosticLogStatus', {
  enabled: true,
  directory: 'C:\\mock\\logs\\llm',
  containsFullContent: true
})
handle('tts:setVoice', undefined)
handle('tts:getVoice', 'kokoro:2')
handle('tts:setSpeed', undefined)
handle('tts:getSpeed', 0.75)
handle('tts:getVoices', [{ id: 'kokoro:2', label: 'Nicole' }])
handle('tts:getLocalModelStatus', {
  installed: true,
  initialized: true,
  modelDir: 'C:\\mock\\tts',
  installer: {
    isInstalling: false,
    progress: 100,
    message: 'ready',
    downloadedBytes: 1
  }
})
handle('stt:getStatus', {
  initialized: true,
  message: 'ready',
  defaultInstallDir: 'C:\\mock\\stt',
  requiredFiles: [],
  missingFiles: [],
  searchedDirs: [],
  supportsPartialResults: false
})
handle('voiceCapture:getSettings', {
  initialSilenceMs: 20000,
  silenceAfterSpeechMs: 5000,
  speechRmsThreshold: 0.012
})
handle('voiceCapture:setSettings', {
  initialSilenceMs: 20000,
  silenceAfterSpeechMs: 5000,
  speechRmsThreshold: 0.012
})
handle('stt:getModelPresets', [])
handle('stt:getInstallerState', {
  isInstalling: false,
  progress: 0,
  message: 'ready',
  downloadedBytes: 0
})
handle('stt:stop', '')
handle('subtitle:listMentions', [])
handle('subtitle:importLocal', null)
handle('subtitle:listLibrary', {
  works: 0,
  packages: 0,
  processedScopes: 0,
  cacheBytes: 0,
  entries: []
})
handle('subtitle:getStatus', {
  sourceProvider: { available: false },
  config: {
    enabled: true,
    sources: {
      subhd: { enabled: true, baseUrls: [] },
      zimuwang: { enabled: false, baseUrls: [] }
    },
    captchaMaxAttempts: 3,
    queryBudgetPerSource: 8,
    sceneConcurrency: 2,
    requestTimeoutMs: 20000
  },
  storage: {
    root: 'C:\\mock\\subtitles',
    writable: true,
    cacheBytes: 0
  },
  sources: []
})

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  await window.loadURL(
    pathToFileURL(join(__dirname, '..', 'out', 'renderer', 'index.html')).href
  )
  await new Promise((resolve) => setTimeout(resolve, 500))

  const verify = async (label) => {
    const result = await window.webContents.executeJavaScript(`(() => ({
      text: document.body.innerText,
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
      emptyCorrectionChecks: document.querySelectorAll(
        '[aria-label="纠错分析完成，未发现需要纠正的问题"]'
      ).length,
      emptyVocabularyChecks: document.querySelectorAll(
        '[aria-label="生词分析完成，没有需要展示的生词"]'
      ).length
    }))()`)
    if (
      !result.text.includes('新对话') ||
      !result.text.includes('生词与关键词') ||
      !result.text.includes('重试分析') ||
      !result.text.includes("can't leave") ||
      result.text.includes('can’t') ||
      result.text.includes('internal reasoning') ||
      result.text.includes('<think>') ||
      result.text.includes('**I agree.**') ||
      result.text.includes('😊') ||
      result.emptyCorrectionChecks < 1 ||
      result.emptyVocabularyChecks < 1
    ) {
      throw new Error(`${label}: expected chat UI was not rendered.`)
    }
    if (result.scrollWidth > result.viewport + 2) {
      throw new Error(`${label}: horizontal overflow ${result.scrollWidth}/${result.viewport}.`)
    }
    return result
  }

  const wide = await verify('1200x800')
  await window.webContents.capturePage().then((image) =>
    require('fs').writeFileSync(
      join(__dirname, '..', 'out', 'test', 'ui-1200x800.png'),
      image.toPNG()
    )
  )

  window.setSize(900, 600)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const compact = await verify('900x600')
  await window.webContents.capturePage().then((image) =>
    require('fs').writeFileSync(
      join(__dirname, '..', 'out', 'test', 'ui-900x600.png'),
      image.toPNG()
    )
  )

  await window.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('复习')
    )?.click()
  `)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const reviewText = await window.webContents.executeJavaScript('document.body.innerText')
  if (!reviewText.includes('学习复习') || !reviewText.includes('今日复习') || !reviewText.includes('提交答案') || !reviewText.includes('语音作答')) {
    throw new Error('Learning review navigation did not render the review page.')
  }
  await window.webContents.capturePage().then((image) =>
    require('fs').writeFileSync(
      join(__dirname, '..', 'out', 'test', 'ui-review-900x600.png'),
      image.toPNG()
    )
  )
  const inspectReviewPanels = () =>
    window.webContents.executeJavaScript(`(() => {
      return {
        buttons: Array.from(document.querySelectorAll('button')).map((button) => button.textContent),
        scrollWidth: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
        text: document.body.innerText
      }
    })()`)
  const compactReview = await inspectReviewPanels()
  if (
    !compactReview.buttons.some((text) => text.includes('提交答案')) ||
    compactReview.scrollWidth > compactReview.viewport + 2 ||
    !compactReview.text.includes('今日待复习')
  ) {
    throw new Error('900x600 daily review layout failed.')
  }
  window.setSize(1200, 800)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const wideReview = await inspectReviewPanels()
  if (wideReview.scrollWidth > wideReview.viewport + 2) {
    throw new Error('Wide daily review layout has horizontal overflow.')
  }
  window.setSize(900, 600)
  await new Promise((resolve) => setTimeout(resolve, 100))

  await window.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('设置')
    )?.click()
  `)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const settings = await window.webContents.executeJavaScript(`(() => ({
    text: document.body.innerText,
    viewport: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    providerOptions: Array.from(document.querySelectorAll('select option')).map(
      (option) => option.textContent
    )
  }))()`)
  for (const expected of ['当前配置', '新增配置', '保存并使用']) {
    if (!settings.text.includes(expected)) {
      throw new Error(`Settings page is missing: ${expected}`)
    }
  }
  for (const provider of ['接口盒子（智谱 GLM）', '百度千帆', 'LongCat']) {
    if (!settings.providerOptions.includes(provider)) {
      throw new Error(`Settings provider is missing: ${provider}`)
    }
  }
  if (settings.scrollWidth > settings.viewport + 2) {
    throw new Error(
      `Settings page horizontal overflow ${settings.scrollWidth}/${settings.viewport}.`
    )
  }
  if (settings.text.includes('ZiMuWang 验证码识别模型') || !settings.text.includes('未包含在线字幕搜索')) {
    throw new Error('Community settings did not hide unavailable private subtitle controls.')
  }
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('input[placeholder="输入电影或电视剧名称"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Example Movie')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 50))
  await window.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('打开字幕知识库')
    )?.click()
  `)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const localWorkflow = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return { text: dialog?.innerText || '', overflow: dialog ? dialog.scrollWidth > dialog.clientWidth + 2 : true }
  })()`)
  if (!localWorkflow.text.includes('导入本地字幕') || !localWorkflow.text.includes('使用本地知识库') || localWorkflow.overflow) {
    throw new Error('Community subtitle workflow did not render a usable local import path.')
  }
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="关闭字幕工作流"]')?.click()`)
  await window.webContents.capturePage().then((image) =>
    require('fs').writeFileSync(
      join(__dirname, '..', 'out', 'test', 'ui-settings-900x600.png'),
      image.toPNG()
    )
  )
  const providerSwitch = await window.webContents.executeJavaScript(`(() => {
    const providerSelect = Array.from(document.querySelectorAll('select')).find(
      (select) => Array.from(select.options).some(
        (option) => option.value === 'qianfan'
      )
    )
    if (!providerSelect) return { changed: false }
    providerSelect.value = 'qianfan'
    providerSelect.dispatchEvent(new Event('change', { bubbles: true }))
    return { changed: true }
  })()`)
  if (!providerSwitch.changed) {
    throw new Error('Could not switch the LLM provider selector.')
  }
  await new Promise((resolve) => setTimeout(resolve, 50))
  const qianfanUrl = await window.webContents.executeJavaScript(`(() => {
    const label = Array.from(document.querySelectorAll('label')).find(
      (item) => item.textContent?.includes('接口地址')
    )
    return label?.querySelector('input')?.value || ''
  })()`)
  if (qianfanUrl !== 'https://qianfan.baidubce.com/v2/chat/completions') {
    throw new Error(`Unexpected Qianfan default URL: ${qianfanUrl}`)
  }
  await window.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('新增配置')
    )?.click()
  `)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const profileCount = await window.webContents.executeJavaScript(`(() => {
    const firstSelect = document.querySelector('select')
    return firstSelect?.options.length || 0
  })()`)
  if (profileCount < 2) {
    throw new Error('Adding a second LLM profile did not update the selector.')
  }

  console.log(
    'UI_SMOKE_OK',
    JSON.stringify({ wide, compact, compactReview, wideReview, settings })
  )
  window.destroy()
  app.exit(0)
}).catch((error) => {
  console.error('UI_SMOKE_FAILED', error)
  app.exit(1)
})
