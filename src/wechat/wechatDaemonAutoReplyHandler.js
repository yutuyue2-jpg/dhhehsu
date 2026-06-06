import {
  getBackgroundAiKeyPayload,
  getBackgroundSnapshot,
  listBackgroundDeviceIds,
} from '../backgroundRuntimeStore.js'
import { normalizeWechatDaemonThreadMeta } from './wechatDaemonStore.js'
import { createAutoBrainServerRuntimeProviders } from './autoBrainServerRuntimeProviders.js'
import { loadFrontendSsrModule } from './frontendSsrModuleLoader.js'

const DEFAULT_MAIN_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MAIN_MODEL = 'gpt-3.5-turbo'

const normalizeText = (value = '') => String(value || '').trim()
const clone = (value) => JSON.parse(JSON.stringify(value))

const THREAD_CONTEXT_LOADER_KEYS = [
  'wechatDaemonThreadContextLoader',
  '__WECHAT_DAEMON_THREAD_CONTEXT_LOADER__'
]

let sharedModulesPromise = null

function isAutoBrainSsrEnabled(env = process.env) {
  return normalizeText(env.WECHAT_DAEMON_ENABLE_AUTOBRAIN_SSR) === '1'
}

function safeId(value = '') {
  return normalizeText(value).replace(/[^\w:-]/g, '').slice(0, 160)
}

function base64UrlToUint8Array(value = '') {
  const text = normalizeText(value).replace(/-/g, '+').replace(/_/g, '/')
  const padded = `${text}${'='.repeat((4 - (text.length % 4)) % 4)}`
  const binary = globalThis.atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function sha256Bytes(value = '') {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')))
}

async function getAesKey(env = process.env) {
  const secret = normalizeText(env.PERSONAL_RUNTIME_DATA_SECRET)
  if (!secret) throw new Error('missing_PERSONAL_RUNTIME_DATA_SECRET')
  const digest = await sha256Bytes(secret)
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['decrypt'])
}

async function decryptBackgroundAiSecret(env = process.env, encrypted = null) {
  if (!encrypted?.ciphertext || !encrypted?.iv) return null
  const key = await getAesKey(env)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToUint8Array(encrypted.iv) },
    key,
    base64UrlToUint8Array(encrypted.ciphertext)
  )
  return JSON.parse(new TextDecoder().decode(plain))
}

function snapshotMatchesWechatThread(snapshot = null, {
  binding = null,
  contact = null
} = {}) {
  const threadKey = normalizeText(binding?.threadKey || binding?.chatId)
  const inferredRoleId = threadKey.match(/role_\d+_[A-Za-z0-9]+/)?.[0] || ''
  const roleId = normalizeText(contact?.id || binding?.roleId || inferredRoleId)
  const roles = Array.isArray(snapshot?.roles) ? snapshot.roles : []
  if (!roleId && !threadKey) return false
  return roles.some((role) => {
    if (roleId && normalizeText(role?.id) === roleId) return true
    const threads = Array.isArray(role?.wechatThreads) ? role.wechatThreads : []
    return threads.some((thread) => {
      const candidate = normalizeText(thread?.chatId || thread?.threadKey)
      return threadKey && candidate === threadKey
    })
  })
}

async function resolveBackgroundDeviceId(env = process.env, {
  threadContext = null,
  binding = null,
  contact = null
} = {}) {
  const explicitId = safeId(
    threadContext?.backgroundDeviceId
    || threadContext?.deviceId
    || env.WECHAT_DAEMON_BACKGROUND_DEVICE_ID
  )
  if (explicitId) return explicitId

  const deviceIds = await listBackgroundDeviceIds(env, 2000).catch(() => [])
  const safeDeviceIds = (Array.isArray(deviceIds) ? deviceIds : [])
    .map((item) => safeId(item))
    .filter(Boolean)
  if (safeDeviceIds.length === 1) return safeDeviceIds[0]

  for (const deviceId of safeDeviceIds.slice(-80).reverse()) {
    const snapshot = await getBackgroundSnapshot(env, deviceId).catch(() => null)
    if (snapshotMatchesWechatThread(snapshot, { binding, contact })) return deviceId
  }
  return ''
}

async function loadBackgroundAiSettings(env = process.env, {
  threadContext = null,
  binding = null,
  contact = null
} = {}) {
  const deviceId = await resolveBackgroundDeviceId(env, { threadContext, binding, contact })
  if (!deviceId) {
    return {
      ok: false,
      error: 'wechat_daemon_background_device_missing'
    }
  }
  const encrypted = await getBackgroundAiKeyPayload(env, deviceId).catch(() => null)
  if (!encrypted) {
    return {
      ok: false,
      error: 'wechat_daemon_background_ai_key_missing',
      backgroundDeviceId: deviceId
    }
  }
  let decrypted = null
  try {
    decrypted = await decryptBackgroundAiSecret(env, encrypted)
  } catch (error) {
    return {
      ok: false,
      error: normalizeText(error?.message) === 'missing_PERSONAL_RUNTIME_DATA_SECRET'
        ? 'wechat_daemon_background_ai_secret_missing'
        : 'wechat_daemon_background_ai_decrypt_failed',
      backgroundDeviceId: deviceId
    }
  }
  if (!decrypted?.apiKey || !decrypted?.baseUrl || !decrypted?.model) {
    return {
      ok: false,
      error: 'wechat_daemon_background_ai_key_invalid',
      backgroundDeviceId: deviceId
    }
  }
  return {
    ok: true,
    apiKey: normalizeText(decrypted.apiKey),
    baseUrl: normalizeText(decrypted.baseUrl),
    model: normalizeText(decrypted.model),
    source: 'background_ai_key',
    backgroundDeviceId: deviceId
  }
}

async function hydrateAiSettingsFromBackgroundKey({
  env = process.env,
  settingsStore = null,
  threadContext = null,
  binding = null,
  contact = null
} = {}) {
  if (settingsStore?.apiKey && settingsStore?.model) return settingsStore
  try {
    const backgroundSettings = await loadBackgroundAiSettings(env, { threadContext, binding, contact })
    if (!backgroundSettings?.ok) {
      return {
        ...settingsStore,
        backgroundAiResolutionError: normalizeText(backgroundSettings?.error),
        backgroundDeviceId: normalizeText(backgroundSettings?.backgroundDeviceId || settingsStore?.backgroundDeviceId)
      }
    }
    return {
      ...settingsStore,
      ...backgroundSettings,
      baseUrl: backgroundSettings.baseUrl || settingsStore?.baseUrl || DEFAULT_MAIN_BASE_URL,
      model: backgroundSettings.model || settingsStore?.model || DEFAULT_MAIN_MODEL
    }
  } catch (error) {
    console.warn('[wechat-daemon] load background ai key failed', error)
    return settingsStore
  }
}

function canUseDirectAiSettings(settingsStore = null) {
  return Boolean(
    settingsStore?.apiKey
    && settingsStore?.model
  )
}

export function getWechatDaemonAiResolutionUserMessage(code = '') {
  const raw = normalizeText(code)
  if (raw === 'wechat_daemon_background_device_missing') {
    return '这条微信线程还没有关联到后台设备 ID。请先打开一次对应聊天页，让线程快照同步到后台。'
  }
  if (raw === 'wechat_daemon_background_ai_key_missing') {
    return '后台设备已经识别到了，但这个设备下还没有保存后台 AI Key。请重新保存一次“后台消息专用 API Key”。'
  }
  if (raw === 'wechat_daemon_background_ai_secret_missing') {
    return '后台解密密钥缺失，当前无法读取已保存的后台 AI Key。请检查部署环境里的 PERSONAL_RUNTIME_DATA_SECRET。'
  }
  if (raw === 'wechat_daemon_background_ai_decrypt_failed') {
    return '后台 AI Key 解密失败。通常是更换过加密密钥后，旧 Key 还没重新保存。请重新保存一次“后台消息专用 API Key”。'
  }
  if (raw === 'wechat_daemon_background_ai_key_invalid') {
    return '后台 AI Key 已读取到，但内容不完整，缺少 API Key、Base URL 或模型。请重新保存一次“后台消息专用 API Key”。'
  }
  if (raw === 'wechat_daemon_ai_settings_missing') {
    return '后台 AI 配置没有读到。请重新保存一次“后台消息专用 API Key”，并打开一次对应聊天页同步线程快照。'
  }
  return raw || '后台 AI 配置暂未就绪'
}

function normalizeInboundUpdate(update = {}, index = 0) {
  const safe = update && typeof update === 'object' ? update : {}
  return {
    id: normalizeText(safe.id || safe.messageId || `wechat_daemon_inbound_${index}`),
    type: normalizeText(safe.type || 'text') || 'text',
    content: normalizeText(safe.content || safe.text || safe.message),
    createdAt: Math.max(0, Number(safe.createdAt || Date.now())),
    from: normalizeText(safe.from),
    contextToken: normalizeText(safe.contextToken || safe.context_token)
  }
}

function buildDaemonDebugState(overrides = {}) {
  const safe = overrides && typeof overrides === 'object' ? overrides : {}
  return {
    updatedAt: Date.now(),
    autoBrainConfigured: safe.autoBrainConfigured === true,
    autoBrainAttempted: safe.autoBrainAttempted === true,
    autoBrainSucceeded: safe.autoBrainSucceeded === true,
    fallbackUsed: safe.fallbackUsed === true,
    route: normalizeText(safe.route),
    error: normalizeText(safe.error),
    errorName: normalizeText(safe.errorName),
    errorStack: normalizeText(safe.errorStack),
    fallbackReason: normalizeText(safe.fallbackReason),
    promptInjectionDebug: safe.promptInjectionDebug && typeof safe.promptInjectionDebug === 'object'
      ? clone(safe.promptInjectionDebug)
      : null
  }
}

function buildPromptInjectionDebug({
  historyMessages = [],
  currentTurnMessages = [],
  threadContext = null
} = {}) {
  const safeHistoryMessages = Array.isArray(historyMessages) ? historyMessages : []
  const safeCurrentTurnMessages = Array.isArray(currentTurnMessages) ? currentTurnMessages : []
  const latestUserMsg = safeCurrentTurnMessages[safeCurrentTurnMessages.length - 1] || null
  const snapshotMessages = Array.isArray(threadContext?.messages) ? threadContext.messages : []
  return {
    snapshotMessageCount: snapshotMessages.length,
    historyMessageCount: safeHistoryMessages.length,
    currentTurnMessageCount: safeCurrentTurnMessages.length,
    latestUserText: normalizeText(
      latestUserMsg?.originalText
      || latestUserMsg?.text
      || latestUserMsg?.content
    ).slice(0, 240),
    historyKeys: safeHistoryMessages.slice(-12).map((message) => buildMessageKey(message)),
    currentTurnKeys: safeCurrentTurnMessages.slice(-12).map((message) => buildMessageKey(message)),
    snapshotKeys: snapshotMessages.slice(-16).map((message) => buildMessageKey(message))
  }
}

function normalizeMessageRoleForKey(role = '') {
  const safeRole = normalizeText(role).toLowerCase()
  if (['ai', 'assistant', 'bot', 'role', 'companion'].includes(safeRole)) return 'assistant'
  if (['user', 'human', 'me'].includes(safeRole)) return 'user'
  return safeRole
}

function normalizeMessageIdForKey(id = '') {
  const safeId = normalizeText(id)
  const wechatIdMatch = safeId.match(/^wechat_(\d+)$/)
  return wechatIdMatch ? wechatIdMatch[1] : safeId
}

function buildMessageKey(message = {}) {
  const id = normalizeMessageIdForKey(message?.id)
  if (id) return `id:${id}`
  return [
    normalizeMessageRoleForKey(message?.role),
    normalizeText(message?.type),
    normalizeText(message?.text || message?.originalText || message?.content),
    Number(message?.timestamp || 0)
  ].join('|')
}

function buildInboundWechatMessage(update = {}, index = 0) {
  const safeUpdate = normalizeInboundUpdate(update, index)
  return {
    id: safeUpdate.id || `wechat_daemon_msg_${safeUpdate.createdAt || Date.now()}_${index}`,
    role: 'user',
    type: safeUpdate.type || 'text',
    text: safeUpdate.content,
    originalText: safeUpdate.content,
    timestamp: safeUpdate.createdAt || Date.now()
  }
}

function buildOutboundWechatMessage(message = {}, index = 0, baseTimestamp = Date.now()) {
  const safe = message && typeof message === 'object' ? message : {}
  const originalText = normalizeText(safe.originalText || safe.text)
  const translatedText = normalizeText(safe.translatedText)
  const transcript = normalizeText(safe.transcript)
  const description = normalizeText(safe.description || safe.desc)
  const timestamp = Math.max(0, Number(safe.timestamp || 0)) || (baseTimestamp + index)
  return {
    id: normalizeText(safe.id) || `wechat_daemon_reply_${timestamp}_${index}`,
    role: 'assistant',
    type: normalizeText(safe.type || 'text') || 'text',
    text: originalText || transcript || description,
    originalText,
    translatedText,
    transcript,
    description,
    url: normalizeText(safe.url || safe.mediaUrl),
    mediaUrl: normalizeText(safe.mediaUrl || safe.url),
    caption: normalizeText(safe.caption),
    timestamp,
    amount: normalizeText(safe.amount),
    status: normalizeText(safe.status || 'queued'),
    source: normalizeText(safe.source || 'daemon_auto_reply')
  }
}

function mergeConversationMessages(baseMessages = [], inboundUpdates = []) {
  const nextMessages = Array.isArray(baseMessages)
    ? baseMessages.map((item) => clone(item))
    : []
  const existingKeys = new Set(nextMessages.map((item) => buildMessageKey(item)))
  inboundUpdates
    .map((item, index) => buildInboundWechatMessage(item, index))
    .forEach((message) => {
      const key = buildMessageKey(message)
      if (existingKeys.has(key)) return
      existingKeys.add(key)
      nextMessages.push(message)
    })
  return nextMessages.sort((left, right) => Number(left?.timestamp || 0) - Number(right?.timestamp || 0))
}

function focusConversationMessages(mergedMessages = [], inboundUpdates = [], historyBeforeLatestInbound = 5, limit = 12) {
  const safeMessages = Array.isArray(mergedMessages) ? mergedMessages.map((item) => clone(item)) : []
  if (!safeMessages.length) return []
  const normalizedInbound = Array.isArray(inboundUpdates)
    ? inboundUpdates.map((item, index) => normalizeInboundUpdate(item, index))
    : []
  const latestInbound = [...normalizedInbound].reverse().find((item) => item.id || item.content) || null
  if (!latestInbound) return safeMessages.slice(-Math.max(1, Number(limit || 12)))
  const latestInboundMessage = buildInboundWechatMessage(latestInbound, 0)
  const latestInboundKey = buildMessageKey(latestInboundMessage)
  let latestInboundIndex = -1
  for (let index = safeMessages.length - 1; index >= 0; index -= 1) {
    if (buildMessageKey(safeMessages[index]) === latestInboundKey) {
      latestInboundIndex = index
      break
    }
  }
  if (latestInboundIndex < 0) return safeMessages.slice(-Math.max(1, Number(limit || 12)))
  const startIndex = Math.max(0, latestInboundIndex - Math.max(0, Number(historyBeforeLatestInbound || 5)))
  return safeMessages.slice(startIndex, latestInboundIndex + 1).slice(-Math.max(1, Number(limit || 12)))
}

function splitCurrentInboundTurn(mergedMessages = [], inboundUpdates = []) {
  const safeMergedMessages = Array.isArray(mergedMessages) ? mergedMessages.map((item) => clone(item)) : []
  const currentTurnMessages = (Array.isArray(inboundUpdates) ? inboundUpdates : [])
    .map((item, index) => buildInboundWechatMessage(item, index))
    .sort((left, right) => Number(left?.timestamp || 0) - Number(right?.timestamp || 0))
  if (!currentTurnMessages.length) {
    return {
      historyMessages: safeMergedMessages,
      currentTurnMessages: [],
      lastUserMsg: [...safeMergedMessages].reverse().find((message) => normalizeText(message?.role) === 'user') || null,
      lastAiMsg: [...safeMergedMessages].reverse().find((message) => normalizeText(message?.role) !== 'user') || null
    }
  }
  const pendingRemovalCounts = new Map()
  currentTurnMessages.forEach((message) => {
    const key = buildMessageKey(message)
    pendingRemovalCounts.set(key, Number(pendingRemovalCounts.get(key) || 0) + 1)
  })
  const historyMessages = safeMergedMessages.filter((message) => {
    const key = buildMessageKey(message)
    const remaining = Number(pendingRemovalCounts.get(key) || 0)
    if (remaining <= 0) return true
    pendingRemovalCounts.set(key, remaining - 1)
    return false
  })
  return {
    historyMessages,
    currentTurnMessages,
    lastUserMsg: currentTurnMessages[currentTurnMessages.length - 1] || null,
    lastAiMsg: [...historyMessages].reverse().find((message) => normalizeText(message?.role) !== 'user') || null
  }
}

function resolveThreadContextLoader(env = process.env) {
  for (const key of THREAD_CONTEXT_LOADER_KEYS) {
    if (typeof env?.[key] === 'function') return env[key]
  }
  return null
}

async function loadThreadContext({
  env = process.env,
  binding = null,
  inboundUpdates = [],
  store = null,
  outboxStore = null
} = {}) {
  const bindingSnapshot = binding?.threadContextSnapshot && typeof binding.threadContextSnapshot === 'object'
    ? clone(binding.threadContextSnapshot)
    : {}
  const loader = resolveThreadContextLoader(env)
  if (typeof loader !== 'function') return bindingSnapshot
  const loaded = await loader({
    env,
    binding,
    inboundUpdates,
    store,
    outboxStore
  })
  return {
    ...bindingSnapshot,
    ...(loaded && typeof loaded === 'object' ? loaded : {})
  }
}

async function loadSharedModules(env = process.env) {
  if (!isAutoBrainSsrEnabled(env)) {
    throw new Error('wechat_daemon_autobrain_ssr_disabled')
  }
  if (!sharedModulesPromise) {
    sharedModulesPromise = Promise.all([
      loadFrontendSsrModule('/src/services/core/autoBrainService.js', env),
      loadFrontendSsrModule('/src/services/memory/roleMemoryService.js', env)
    ]).then(([autoBrainService, roleMemoryService]) => ({
      createAutoBrainServerRuntimeProviders,
      autoBrainService,
      roleMemoryService
    })).catch((error) => {
      sharedModulesPromise = null
      throw error
    })
  }
  return sharedModulesPromise
}

function resolveAiSettings(env = process.env, threadContext = null) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  const seed = safeThreadContext.settingsStore && typeof safeThreadContext.settingsStore === 'object'
    ? clone(safeThreadContext.settingsStore)
    : {}
  return {
    ...seed,
    apiKey: normalizeText(
      seed.apiKey
      || env.WECHAT_DAEMON_AI_API_KEY
      || env.AI_PHONE_AI_API_KEY
      || env.OPENAI_API_KEY
    ),
    baseUrl: normalizeText(
      seed.baseUrl
      || env.WECHAT_DAEMON_AI_BASE_URL
      || env.AI_PHONE_AI_BASE_URL
      || env.OPENAI_BASE_URL
      || DEFAULT_MAIN_BASE_URL
    ) || DEFAULT_MAIN_BASE_URL,
    model: normalizeText(
      seed.model
      || env.WECHAT_DAEMON_AI_MODEL
      || env.AI_PHONE_AI_MODEL
      || env.OPENAI_MODEL
      || DEFAULT_MAIN_MODEL
    ) || DEFAULT_MAIN_MODEL,
    modelTemperatureSettings: seed.modelTemperatureSettings || {}
  }
}

function buildRoleContact(binding = null, threadContext = null, mergedMessages = []) {
  const safeBinding = binding && typeof binding === 'object' ? binding : {}
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  const seededContact = safeThreadContext.contact && typeof safeThreadContext.contact === 'object'
    ? clone(safeThreadContext.contact)
    : {}
  const roleId = normalizeText(seededContact.id || safeBinding.roleId)
  return {
    ...seededContact,
    id: roleId,
    name: normalizeText(
      seededContact.name
      || seededContact.wechatIdentityDisplayName
      || safeBinding.externalAccountName
      || roleId
      || '对方'
    ) || '对方',
    sessionAccountId: normalizeText(seededContact.sessionAccountId || safeBinding.accountId),
    sessionChatId: normalizeText(seededContact.sessionChatId || safeBinding.chatId || safeBinding.threadKey),
    wechatIdentityId: normalizeText(seededContact.wechatIdentityId || safeBinding.identity || 'main') || 'main',
    messages: Array.isArray(mergedMessages) && mergedMessages.length
      ? mergedMessages
      : (Array.isArray(seededContact.messages) ? seededContact.messages : []),
    recentEvents: Array.isArray(seededContact.recentEvents) ? seededContact.recentEvents : [],
    memory: seededContact.memory && typeof seededContact.memory === 'object' ? seededContact.memory : {}
  }
}

function buildRoleStore(binding = null, threadContext = null, contact = null) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  if (safeThreadContext.roleStore && typeof safeThreadContext.roleStore === 'object') {
    return safeThreadContext.roleStore
  }
  const roleSeed = safeThreadContext.role && typeof safeThreadContext.role === 'object'
    ? clone(safeThreadContext.role)
    : {}
  const roleRecord = {
    ...roleSeed,
    ...(contact && typeof contact === 'object' ? clone(contact) : {})
  }
  const roles = Array.isArray(safeThreadContext.roles)
    ? safeThreadContext.roles.map((item) => clone(item))
    : (roleRecord.id ? [clone(roleRecord)] : [])
  return {
    roles,
    getWechatIdentityRole(roleId = '', options = {}) {
      const safeRoleId = normalizeText(roleId)
      const explicitAccountId = normalizeText(options?.accountId)
      const explicitIdentity = normalizeText(options?.identity || 'main') || 'main'
      if (roleRecord.id && roleRecord.id === safeRoleId) {
        return {
          ...clone(roleRecord),
          sessionAccountId: explicitAccountId || roleRecord.sessionAccountId || normalizeText(binding?.accountId),
          sessionChatId: normalizeText(roleRecord.sessionChatId || binding?.chatId || binding?.threadKey),
          wechatIdentityId: explicitIdentity || roleRecord.wechatIdentityId || normalizeText(binding?.identity || 'main')
        }
      }
      return roles.find((item) => normalizeText(item?.id) === safeRoleId) || null
    },
    resolveWechatSessionAccountId(roleId = '') {
      return normalizeText(roleId) === normalizeText(roleRecord.id)
        ? normalizeText(roleRecord.sessionAccountId || binding?.accountId)
        : ''
    }
  }
}

function buildMomentsStore(threadContext = null) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  if (safeThreadContext.momentsStore && typeof safeThreadContext.momentsStore === 'object') {
    return safeThreadContext.momentsStore
  }
  return {
    posts: Array.isArray(safeThreadContext.momentPosts) ? safeThreadContext.momentPosts.map((item) => clone(item)) : []
  }
}

function buildUserStore(threadContext = null, runtimeProviders = null, contact = null) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  if (safeThreadContext.userStore && typeof safeThreadContext.userStore === 'object') {
    return safeThreadContext.userStore
  }
  return {
    userInfo: runtimeProviders?.resolveCurrentWechatUserInfo?.(contact, safeThreadContext.userInfo || null) || safeThreadContext.userInfo || {}
  }
}

function buildScheduleContext(threadContext = null, inboundUpdates = []) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  const lastInbound = [...inboundUpdates].reverse().find((item) => Number(item?.createdAt || 0) > 0) || null
  const deliveredAt = Number(
    safeThreadContext.scheduleContext?.deliveredAt
    || lastInbound?.createdAt
    || Date.now()
  )
  return {
    ...(safeThreadContext.scheduleContext && typeof safeThreadContext.scheduleContext === 'object'
      ? clone(safeThreadContext.scheduleContext)
      : {}),
    deliveredAt
  }
}

function isDirectiveOnlyLine(text = '') {
  const value = normalizeText(text)
  if (!value) return false
  return /^\[[^\]]+\]$/.test(value) || /^【[^】]+】$/.test(value)
}

function extractStickerTokenFromDirective(text = '') {
  const value = normalizeText(text)
  const match = value.match(/^[\[【]\s*(?:表情|sticker)\s*[:：]\s*([^\]】]+?)\s*[\]】]$/i)
  return normalizeText(match?.[1] || '')
}

function isWechatMediaUrl(value = '') {
  const text = normalizeText(value)
  return /^https?:\/\//i.test(text)
}

function resolveCustomStickerMediaUrl(customStickers = [], token = '') {
  const safeToken = normalizeText(token).toLowerCase()
  if (!safeToken) return ''
  const stickers = Array.isArray(customStickers) ? customStickers : []
  const matched = stickers.find((item) => {
    const names = [
      item?.token,
      item?.name,
      item?.title,
      item?.label,
      item?.id,
      item?.desc,
      item?.description,
      item?.category
    ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean)
    return names.includes(safeToken)
  })
  const mediaUrl = normalizeText(
    matched?.mediaUrl
    || matched?.imageUrl
    || matched?.url
    || matched?.src
    || matched?.previewUrl
  )
  return isWechatMediaUrl(mediaUrl) ? mediaUrl : ''
}

function normalizeRenderableReplyText(text = '') {
  return normalizeText(text)
    .replace(/^\s*\[(?:语音|voice)\]\s*/i, '')
    .replace(/^\s*\[(?:assistant|ai|助手|角色)\]\s*[:：]\s*/i, '')
    .trim()
}

function splitWechatBilingualReplyText(text = '') {
  const normalized = normalizeRenderableReplyText(text)
  if (!normalized || isDirectiveOnlyLine(normalized)) {
    return {
      language: '',
      originalText: normalized,
      translatedText: ''
    }
  }
  const protocolMatch = normalized.match(/^@@msg:([a-zA-Z-]+)@@\s*([\s\S]+)$/i)
  const language = normalizeText(protocolMatch?.[1] || '')
  const protocolPayload = normalizeText(protocolMatch?.[2] || normalized)
  const separatorMatch = protocolPayload.match(/^(.*?)\s*(?:\|\||｜｜)\s*(.*?)$/)
  const originalText = normalizeText(separatorMatch?.[1] || normalized)
  const translatedText = normalizeText(separatorMatch?.[2] || '')
  if (!separatorMatch || !originalText || !translatedText) {
    return {
      language,
      originalText: protocolPayload || normalized,
      translatedText: ''
    }
  }
  return {
    language,
    originalText,
    translatedText
  }
}

function formatWechatBilingualBubbleText(originalText = '', translatedText = '') {
  const primary = normalizeRenderableReplyText(originalText)
  const translation = normalizeRenderableReplyText(translatedText)
  if (primary && translation) {
    return `${primary}\n${translation}`
  }
  return primary || translation
}

function normalizeWechatReplyTextPayload(message = null) {
  const safeMessage = message && typeof message === 'object' ? message : {}
  const inlineParsed = splitWechatBilingualReplyText(
    safeMessage?.originalText
    || safeMessage?.text
    || safeMessage?.content
    || ''
  )
  const translatedText = normalizeRenderableReplyText(
    safeMessage?.translatedText
    || inlineParsed.translatedText
  )
  const originalText = normalizeRenderableReplyText(
    inlineParsed.originalText
    || safeMessage?.originalText
    || safeMessage?.text
    || safeMessage?.content
    || ''
  )
  return {
    language: inlineParsed.language,
    originalText,
    translatedText,
    displayText: formatWechatBilingualBubbleText(originalText, translatedText)
  }
}

function extractReplyLines(replyAction = null) {
  if (!replyAction || typeof replyAction !== 'object') return []
  return String(replyAction.replyText || replyAction.text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => normalizeRenderableReplyText(line))
    .filter(Boolean)
}

function extractRenderableReplyTexts(replyAction = null) {
  if (!replyAction || typeof replyAction !== 'object') return []
  const replyMessages = Array.isArray(replyAction.replyMessages) ? replyAction.replyMessages : []
  const textsFromMessages = replyMessages
    .map((message) => normalizeWechatReplyTextPayload(message).displayText)
    .filter((item) => item && !isDirectiveOnlyLine(item))
  if (textsFromMessages.length) return textsFromMessages
  return extractReplyLines(replyAction)
    .map((line) => normalizeWechatReplyTextPayload({ originalText: line }).displayText)
    .filter((line) => line && !isDirectiveOnlyLine(line))
}

function buildOutboxMessages({
  binding = null,
  inboundUpdates = [],
  replyAction = null,
  customStickers = []
} = {}) {
  const safeBinding = binding && typeof binding === 'object' ? binding : {}
  const latestInbound = [...inboundUpdates]
    .map((item, index) => normalizeInboundUpdate(item, index))
    .reverse()
    .find((item) => item.from || item.contextToken)
  const buildBaseEnvelope = (index = 0) => ({
    threadMeta: normalizeWechatDaemonThreadMeta(safeBinding),
    to: normalizeText(latestInbound?.from || safeBinding.lastInboundFrom),
    contextToken: normalizeText(latestInbound?.contextToken || safeBinding.lastInboundContextToken),
    source: 'daemon_auto_reply',
    idempotencyKey: [
      'wechat_daemon_auto_reply',
      normalizeText(safeBinding.threadKey || safeBinding.chatId),
      normalizeText(latestInbound?.id || latestInbound?.createdAt || Date.now()),
      index
    ].filter(Boolean).join(':')
  })
  const replyMessages = Array.isArray(replyAction?.replyMessages) ? replyAction.replyMessages : []
  const messagesFromReplyPayload = replyMessages
    .map((message, index) => {
      const type = normalizeText(message?.type || 'text')
      const mediaUrl = normalizeText(message?.mediaUrl || message?.url)
      if (type === 'sticker' && !mediaUrl) return null
      const textPayload = normalizeWechatReplyTextPayload(message)
      const content = normalizeText(
        textPayload.displayText
        || message?.transcript
        || message?.description
      )
      if ((type === 'image' || type === 'sticker') && mediaUrl) {
        const normalizedMediaType = type === 'sticker' ? 'sticker' : 'image'
        return {
          ...buildBaseEnvelope(index),
          type: normalizedMediaType,
          content: normalizedMediaType === 'sticker'
            ? '[表情]'
            : (content || '[图片]'),
          caption: normalizedMediaType === 'sticker'
            ? ''
            : normalizeText(message?.caption || message?.description || message?.text),
          mediaUrl
        }
      }
      if (!content) return null
      return {
        ...buildBaseEnvelope(index),
        type: 'text',
        content
      }
    })
    .filter(Boolean)
  if (messagesFromReplyPayload.length) return messagesFromReplyPayload
  return extractReplyLines(replyAction)
    .map((content, index) => {
      const stickerToken = extractStickerTokenFromDirective(content)
      if (stickerToken) {
        const mediaUrl = resolveCustomStickerMediaUrl(customStickers, stickerToken)
        if (!mediaUrl) return null
        return {
          ...buildBaseEnvelope(index),
          type: 'sticker',
          content: `[表情:${stickerToken}]`,
          caption: '',
          mediaUrl
        }
      }
      if (isDirectiveOnlyLine(content)) return null
      const textPayload = normalizeWechatReplyTextPayload({ originalText: content })
      return {
        ...buildBaseEnvelope(index),
        type: 'text',
        content: textPayload.displayText || content
      }
    })
    .filter(Boolean)
}

function buildReplyThreadContextMessages(replyAction = null, customStickers = []) {
  const baseTimestamp = Date.now()
  const replyMessages = Array.isArray(replyAction?.replyMessages) ? replyAction.replyMessages : []
  if (replyMessages.length) {
    return replyMessages
      .map((message, index) => {
        const type = normalizeText(message?.type || 'text')
        const mediaUrl = normalizeText(message?.mediaUrl || message?.url)
        if (type === 'sticker' && !mediaUrl) return null
        const textPayload = normalizeWechatReplyTextPayload(message)
        return buildOutboundWechatMessage({
          ...message,
          text: textPayload.displayText || message?.text,
          originalText: textPayload.originalText || message?.originalText || message?.text,
          translatedText: textPayload.translatedText || message?.translatedText,
          source: normalizeText(message?.source || 'daemon_auto_reply')
        }, index, baseTimestamp)
      })
      .filter((message) => (
        message.id
        || message.originalText
        || message.text
        || message.transcript
        || message.description
      ))
  }
  return extractReplyLines(replyAction)
    .map((text, index) => {
      const stickerToken = extractStickerTokenFromDirective(text)
      if (stickerToken) {
        const mediaUrl = resolveCustomStickerMediaUrl(customStickers, stickerToken)
        if (!mediaUrl) return null
        return buildOutboundWechatMessage({
          type: 'sticker',
          originalText: `[表情:${stickerToken}]`,
          caption: '',
          mediaUrl,
          url: mediaUrl,
          source: 'daemon_auto_reply'
        }, index, baseTimestamp)
      }
      if (isDirectiveOnlyLine(text)) return null
      const textPayload = normalizeWechatReplyTextPayload({ originalText: text })
      return buildOutboundWechatMessage({
        type: 'text',
        text: textPayload.displayText || text,
        originalText: textPayload.originalText || text,
        translatedText: textPayload.translatedText,
        source: 'daemon_auto_reply'
      }, index, baseTimestamp)
    })
    .filter(Boolean)
}

function findReplyAction(plan = null) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : []
  return actions.find((action) => {
    if (normalizeText(action?.type) !== 'wechat_reply') return false
    const replyMessages = Array.isArray(action?.replyMessages) ? action.replyMessages : []
    if (replyMessages.some((message) => (
      normalizeText(message?.mediaUrl || message?.url)
      || normalizeText(message?.originalText || message?.translatedText || message?.text)
    ))) return true
    return extractReplyLines(action).length > 0
  }) || null
}

function normalizeChatCompletionEndpoint(baseUrl = '') {
  const clean = normalizeText(baseUrl || DEFAULT_MAIN_BASE_URL).replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(clean)) return clean
  if (/\/v\d+$/i.test(clean)) return `${clean}/chat/completions`
  return `${clean}/v1/chat/completions`
}

function normalizeTextLanguage(value = '') {
  const normalized = normalizeText(value || 'zh').toLowerCase()
  if (normalized.startsWith('en')) return 'en'
  if (normalized.startsWith('ja')) return 'ja'
  if (normalized.startsWith('ko')) return 'ko'
  return 'zh'
}

function resolveVoiceLanguage(textLanguage = 'zh', voiceLanguage = '') {
  const normalizedVoice = normalizeTextLanguage(voiceLanguage || '')
  if (!voiceLanguage || normalizeText(voiceLanguage) === 'follow_text') {
    return normalizeTextLanguage(textLanguage)
  }
  return normalizedVoice
}

function describeDirectMessageForPrompt(message = null) {
  const safeMessage = message && typeof message === 'object' ? message : {}
  const textPayload = normalizeWechatReplyTextPayload(safeMessage)
  const content = normalizeText(textPayload.displayText || safeMessage?.content)
  if (content) return content
  const type = normalizeText(safeMessage?.type || 'text')
  if (type === 'image') return '（发送了一张图片）'
  if (type === 'voice') return '（发送了一条语音）'
  if (type === 'video') return '（发送了一段视频）'
  if (type === 'sticker') return '（发送了一个表情）'
  return '（发送了一条非文本消息）'
}

function hasOwnProperty(target = null, key = '') {
  return Boolean(target && typeof target === 'object' && Object.prototype.hasOwnProperty.call(target, key))
}

function isTimeAwareEnabled(chat = null) {
  if (!chat || typeof chat !== 'object') return true
  if (hasOwnProperty(chat, 'timeAwareEnabled')) {
    return chat.timeAwareEnabled !== false
  }
  if (hasOwnProperty(chat, 'timeAware')) {
    return chat.timeAware === true
  }
  if (hasOwnProperty(chat, 'scheduleEffectEnabled')) {
    return chat.scheduleEffectEnabled !== false
  }
  return true
}

function isChatTimeAwarenessEnabled(chat = null) {
  if (!chat || typeof chat !== 'object') return true
  if (hasOwnProperty(chat, 'chatTimeAwarenessEnabled')) {
    return chat.chatTimeAwarenessEnabled !== false
  }
  if (hasOwnProperty(chat, 'chatTimeAwareness')) {
    return chat.chatTimeAwareness !== false
  }
  return true
}

function isTimezoneAwarenessEnabled(chat = null) {
  if (!chat || typeof chat !== 'object') return false
  if (hasOwnProperty(chat, 'timezoneAwarenessEnabled')) {
    return chat.timezoneAwarenessEnabled === true
  }
  if (hasOwnProperty(chat, 'timezoneAwareness')) {
    return chat.timezoneAwareness === true
  }
  return false
}

function getRoleTimeZone(chat = null, fallback = 'Asia/Shanghai') {
  const raw = normalizeText(chat?.roleTimeZone)
  return raw || fallback
}

function resolvePromptUserTimeZone(threadContext = null) {
  return normalizeText(threadContext?.userTimeZone) || 'Asia/Shanghai'
}

function resolvePromptUserLabel(threadContext = null) {
  return normalizeText(threadContext?.wechatAccountName || threadContext?.accountName) || '对方'
}

function toValidDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function isSameLocalDate(left, right) {
  return (
    left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
  )
}

function isYesterdayLocalDate(left, right) {
  const yesterday = new Date(right)
  yesterday.setDate(yesterday.getDate() - 1)
  return isSameLocalDate(left, yesterday)
}

function buildNowString(nowTs = Date.now()) {
  const now = new Date(nowTs)
  const hour = Number(now.getHours())
  const minute = pad2(now.getMinutes())
  const phase = hour < 5
    ? '凌晨'
    : hour < 8
      ? '早上'
      : hour < 12
        ? '上午'
        : hour < 14
          ? '中午'
          : hour < 18
            ? '下午'
            : '晚上'
  const hour12 = hour % 12 || 12
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(hour)}:${minute}（24小时制，本地时间），也就是${phase}${hour12}:${minute}`
}

function formatPrivateChatCurrentPhase(nowTs = Date.now()) {
  const now = toValidDate(nowTs)
  if (!now) return '当前时段'
  const hour = now.getHours()
  if (hour < 5) return '今天凌晨'
  if (hour < 8) return '今天早上'
  if (hour < 12) return '今天上午'
  if (hour < 14) return '今天中午'
  if (hour < 18) return '今天下午'
  if (hour < 22) return '今晚'
  return '今天深夜'
}

function formatPrivateChatClock(timestamp) {
  const date = toValidDate(timestamp)
  if (!date) return ''
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function formatPrivateChatCalendarTime(timestamp, nowTs = Date.now()) {
  const date = toValidDate(timestamp)
  const now = toValidDate(nowTs)
  if (!date || !now) return ''
  const clock = formatPrivateChatClock(date)
  if (isSameLocalDate(date, now)) {
    const hour = date.getHours()
    if (hour < 5) return `今天凌晨 ${clock}`
    if (hour < 8) return `今天早上 ${clock}`
    if (hour < 12) return `今天上午 ${clock}`
    if (hour < 14) return `今天中午 ${clock}`
    if (hour < 18) return `今天下午 ${clock}`
    return `今晚 ${clock}`
  }
  if (isYesterdayLocalDate(date, now)) {
    const hour = date.getHours()
    if (hour < 5) return `昨天凌晨 ${clock}`
    if (hour < 8) return `昨天早上 ${clock}`
    if (hour < 12) return `昨天上午 ${clock}`
    if (hour < 14) return `昨天中午 ${clock}`
    if (hour < 18) return `昨天下午 ${clock}`
    return `昨晚 ${clock}`
  }
  return `${pad2(date.getMonth() + 1)}月${pad2(date.getDate())}日 ${clock}`
}

function formatPrivateChatElapsedTime(timestamp, nowTs = Date.now()) {
  const date = toValidDate(timestamp)
  const now = toValidDate(nowTs)
  if (!date || !now) return ''
  const diff = Math.max(0, now.getTime() - date.getTime())
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`
  if (diff < day) return `${Math.floor(diff / hour)}小时前`
  return `${Math.floor(diff / day)}天前`
}

function formatPrivateChatTimeReference(timestamp, nowTs = Date.now(), options = {}) {
  const calendarText = formatPrivateChatCalendarTime(timestamp, nowTs)
  if (!calendarText) return ''
  const elapsedText = options.includeElapsed
    ? formatPrivateChatElapsedTime(timestamp, nowTs)
    : ''
  if (!elapsedText) return calendarText
  return `${calendarText}（${elapsedText}）`
}

function formatTimeInZone(nowTs = Date.now(), timeZone = '', locale = 'zh-CN') {
  const safeDate = new Date(Number(nowTs || Date.now()))
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timeZone || undefined,
      hourCycle: 'h23',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(safeDate)
  } catch {
    return new Intl.DateTimeFormat(locale, {
      hourCycle: 'h23',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(safeDate)
  }
}

function getTimezoneOffsetHours(nowTs = Date.now(), timeZone = '') {
  if (!timeZone) return null
  const safeDate = new Date(Number(nowTs || Date.now()))
  try {
    const asText = safeDate.toLocaleString('en-US', { timeZone })
    const asDate = new Date(asText)
    const offsetMs = asDate.getTime() - safeDate.getTime()
    return Math.round((offsetMs / 3600000) * 2) / 2
  } catch {
    return null
  }
}

function buildTimezoneContextBlock({
  enabled = false,
  nowTs = Date.now(),
  userTimeZone = '',
  roleTimeZone = '',
  userLabel = ''
} = {}) {
  if (!enabled) return ''
  const safeRoleTimeZone = String(roleTimeZone || '').trim()
  if (!safeRoleTimeZone) return ''
  const safeUserTimeZone = String(userTimeZone || '').trim() || 'Asia/Shanghai'
  const safeUserLabel = String(userLabel || '').trim() || '对方'
  const userNowText = formatTimeInZone(nowTs, safeUserTimeZone, 'zh-CN')
  const roleNowText = formatTimeInZone(nowTs, safeRoleTimeZone, 'zh-CN')
  const userOffset = getTimezoneOffsetHours(nowTs, safeUserTimeZone)
  const roleOffset = getTimezoneOffsetHours(nowTs, safeRoleTimeZone)
  const diffHours = Number.isFinite(userOffset) && Number.isFinite(roleOffset)
    ? Math.round((roleOffset - userOffset) * 2) / 2
    : null
  const diffLabel = diffHours === null
    ? '时差未知'
    : diffHours === 0
      ? `与${safeUserLabel}无时差`
      : diffHours > 0
        ? `比${safeUserLabel}快 ${diffHours} 小时`
        : `比${safeUserLabel}慢 ${Math.abs(diffHours)} 小时`
  return [
    '【时差参考】',
    `- ${safeUserLabel}当地时间（${safeUserTimeZone}）：${userNowText}`,
    `- 角色当地时间（${safeRoleTimeZone}）：${roleNowText}`,
    `- 双方时差：${diffLabel}`,
    '- 若要提到“早/晚/凌晨/昨晚”，优先以角色当地时间组织表达。'
  ].join('\n')
}

function buildDirectTimeAndEventBlock({
  threadContext = null,
  historyMessages = [],
  currentTurnMessages = [],
  includeTimeContext = true,
  timezoneContextBlock = '',
  nowTs = Date.now()
} = {}) {
  const userDisplayName = resolvePromptUserLabel(threadContext)
  const nowStr = buildNowString(nowTs)
  const safeHistoryMessages = Array.isArray(historyMessages) ? historyMessages : []
  const safeCurrentTurnMessages = Array.isArray(currentTurnMessages) ? currentTurnMessages : []
  const lastUserMsg = safeCurrentTurnMessages[safeCurrentTurnMessages.length - 1] || null
  const lastAiMsg = [...safeHistoryMessages].reverse().find((message) => normalizeText(message?.role) !== 'user') || null
  const latestUserText = describeDirectMessageForPrompt(lastUserMsg)
  const anchorLines = ['时间与事件坐标：']
  const currentTurnLines = [`${userDisplayName}这一轮最后发来的内容：`]
  anchorLines.push(includeTimeContext
    ? `- 当前本地时间：${nowStr}，属于${formatPrivateChatCurrentPhase(nowTs)}。`
    : '- 当前时间感知已关闭。不要根据真实时钟、早晚或消息间隔自行脑补具体时段。')
  anchorLines.push(timezoneContextBlock
    ? '- 时差感知：已开启，请严格参考下方【时差参考】。'
    : '- 时差感知：未开启。')
  if (includeTimeContext) {
    anchorLines.push('- 如果对方问“现在几点 / 现在是上午还是下午”，必须严格按这条本地时间回答；18:58 是傍晚，不是大半夜，也不是凌晨。')
    anchorLines.push('- 你对“刚刚 / 今天 / 昨晚 / 半夜 / 凌晨 / 下午”的判断，必须服从这里注入的时间，不要自己脑补。')
    anchorLines.push('- 如果记忆、线下记录、电话或群聊记录显示这段消息间隔里你们共同经历过事情，不要把微信空白直接说成对方一直不理你。')
  }
  if (lastUserMsg) {
    const userTimeText = includeTimeContext
      ? formatPrivateChatTimeReference(lastUserMsg.timestamp, nowTs)
      : '当前这一轮'
    anchorLines.push(`- ${userDisplayName}这一轮最后一条消息发于：${userTimeText}。`)
    currentTurnLines.push(includeTimeContext ? `- 发来时间：${userTimeText}` : '')
    currentTurnLines.push(`- 内容：${latestUserText || '（无文字内容）'}`)
    currentTurnLines.push('- 真正当前轮逐条消息和它们各自的时间，请以下方 user 输入列表为准；最后一条才是你现在要接的那条。')
  } else {
    currentTurnLines.push(`- 以${userDisplayName}这一轮最新输入为准，不要自己脑补新的提问或情绪。`)
  }
  if (lastAiMsg) {
    const aiTimeText = includeTimeContext
      ? formatPrivateChatTimeReference(lastAiMsg.timestamp, nowTs)
      : '上一轮'
    anchorLines.push(`- 你上一次回复发于：${aiTimeText}。`)
    if (includeTimeContext && lastUserMsg?.timestamp && lastAiMsg?.timestamp) {
      anchorLines.push(`- ${userDisplayName}这次再次出现，距离你上次回复已经过去了${formatPrivateChatElapsedTime(lastAiMsg.timestamp, lastUserMsg.timestamp)}。`)
    }
  }
  anchorLines.push('- “昨天 / 今天 / 昨晚 / 半夜 / 凌晨”一律按自然日理解；跨过午夜就是新的一天。')
  const sections = [
    anchorLines.join('\n'),
    currentTurnLines.filter(Boolean).join('\n')
  ]
  if (timezoneContextBlock) sections.push(timezoneContextBlock)
  return sections.filter(Boolean).join('\n\n')
}

function formatDirectRecentTimeline(historyMessages = [], limit = 8) {
  const safeHistory = Array.isArray(historyMessages) ? historyMessages : []
  const lines = safeHistory
    .slice(-Math.max(1, Number(limit || 0)))
    .map((message) => {
      const role = normalizeText(message?.role) === 'assistant' ? '你' : '用户'
      const content = describeDirectMessageForPrompt(message)
      return content ? `- ${role}：${content}` : ''
    })
    .filter(Boolean)
  return lines.length ? ['近期互动轨迹：', ...lines].join('\n') : ''
}

function formatDirectLanguageRuleBlock(contact = null) {
  const textLanguage = normalizeTextLanguage(contact?.textLanguage || 'zh')
  const resolvedVoiceLanguage = resolveVoiceLanguage(textLanguage, contact?.voiceLanguage || '')
  if (textLanguage === 'zh' && resolvedVoiceLanguage === 'zh') {
    return [
      '语言输出规范：',
      '- 默认直接用自然中文回复，不要翻译腔，不要解释自己在扮演角色。',
      '- 如果一次要发多条气泡，用真实聊天口吻断句，每行一条。'
    ].join('\n')
  }
  return [
    '语言输出规范：',
    `- 文字语言优先使用 ${textLanguage}，但每条文字气泡都必须同时带中文翻译。`,
    `- 双语文本必须使用机器协议：\`@@msg:${textLanguage}@@目标语言正文||中文翻译\`，每行只表达一个语义点。`,
    '- 不要自己输出“中文：”“翻译：”之类标签；系统会自动整理成适合微信的双行气泡。',
    `- 若输出语音文案，语音正文优先使用 ${resolvedVoiceLanguage}，但仍需让同轮文字回复保留中文可读信息。`,
    '- 图片描述、动作说明、表情指令始终保持中文。'
  ].join('\n')
}

function formatDirectSpeakingRulesBlock(contact = null) {
  const roleName = normalizeText(contact?.remarkName || contact?.name) || '对方'
  const minReplyCount = Math.max(0, Number(contact?.minReplyCount || 0))
  const maxReplyCount = Math.max(minReplyCount || 0, Number(contact?.maxReplyCount || 0))
  const replyCountHint = maxReplyCount > 0
    ? `- 回复条数偏好：尽量控制在 ${Math.max(1, minReplyCount || 1)} 到 ${Math.max(1, maxReplyCount)} 条气泡内。`
    : ''
  return [
    `角色回复规则（你就是「${roleName}」本人）：`,
    '- 优先保持角色原本的语气、脾气、亲密度、口头禅，不要掉回通用 AI 客服腔。',
    '- 回复要像真实私聊，不解释思考过程，不总结规则，不复述系统提示。',
    '- 历史消息只做上下文参考；这一次必须整体回应用户本回合连续发来的内容，不要只盯最后一句。',
    '- 如果用户这一轮有多个点，优先一次性接住主要点，再自然分配到 1 到 3 条气泡里。',
    '- 没把握时宁可少说、贴近人设，也不要泛泛安慰或机械复述。',
    replyCountHint
  ].join('\n')
}

function formatDirectContextBlock(threadContext = null, contact = null) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  const safeContact = contact && typeof contact === 'object' ? contact : {}
  const memory = safeContact.memory && typeof safeContact.memory === 'object'
    ? safeContact.memory
    : {}
  const memoryText = normalizeText(
    memory.summary
    || memory.memorySummary
    || memory.longTermMemory
    || memory.profile
    || ''
  )
  const recentEventCount = Math.max(0, Number(safeContact.contextEventCount || 0)) || 12
  const recentEvents = Array.isArray(safeContact.recentEvents)
    ? safeContact.recentEvents.slice(-recentEventCount)
    : []
  const worldBookEntries = Array.isArray(safeThreadContext.worldBookEntries)
    ? safeThreadContext.worldBookEntries.slice(0, 24)
    : []
  const scheduleContext = safeThreadContext.scheduleContext && typeof safeThreadContext.scheduleContext === 'object'
    ? safeThreadContext.scheduleContext
    : null
  const replyStrategyContext = safeThreadContext.replyStrategyContext && typeof safeThreadContext.replyStrategyContext === 'object'
    ? safeThreadContext.replyStrategyContext
    : null
  const recentInteractionContext = safeThreadContext.recentInteractionContext
  const lines = []
  if (memoryText) lines.push(`角色动态记忆：${memoryText}`)
  if (safeContact.wechatIdentityDisplayName || safeContact.wechatIdentityAccountDescription || safeContact.wechatIdentityInstruction) {
    const identityLines = []
    if (safeContact.wechatIdentityDisplayName) identityLines.push(`当前微信身份显示名：${safeContact.wechatIdentityDisplayName}`)
    if (safeContact.wechatIdentityAccountDescription) identityLines.push(`当前微信身份说明：${safeContact.wechatIdentityAccountDescription}`)
    if (safeContact.wechatIdentityInstruction) identityLines.push(`当前微信身份额外要求：${safeContact.wechatIdentityInstruction}`)
    if (identityLines.length) lines.push(identityLines.join('\n'))
  }
  if (recentEvents.length) {
    lines.push('近期上下文事件：')
    recentEvents.forEach((event) => {
      const text = normalizeText(event?.text || event?.commentText || event?.privateMessageText)
      if (text) lines.push(`- ${text}`)
    })
  }
  if (worldBookEntries.length) {
    lines.push('世界书/长期设定：')
    worldBookEntries.forEach((entry) => {
      const title = normalizeText(entry?.title)
      const content = normalizeText(entry?.content)
      if (content) lines.push(`- ${title ? `${title}：` : ''}${content}`)
    })
  }
  if (scheduleContext) {
    const scheduleLines = []
    if (scheduleContext.currentStatusText || scheduleContext.currentStatus) {
      scheduleLines.push(`当前状态：${scheduleContext.currentStatusText || scheduleContext.currentStatus}`)
    }
    if (scheduleContext.displayStatus) scheduleLines.push(`展示状态：${scheduleContext.displayStatus}`)
    if (scheduleContext.replyDelayMode) scheduleLines.push(`回复模式：${scheduleContext.replyDelayMode}`)
    if (scheduleContext.currentBlock?.title) {
      scheduleLines.push(`当前时间段：${scheduleContext.currentBlock.title}`)
    }
    if (scheduleLines.length) lines.push(scheduleLines.join('\n'))
  }
  if (replyStrategyContext) {
    const strategyLines = []
    if (replyStrategyContext.strategy) strategyLines.push(`本轮策略：${replyStrategyContext.strategy}`)
    if (replyStrategyContext.moodHint) strategyLines.push(`情绪提示：${replyStrategyContext.moodHint}`)
    if (replyStrategyContext.dayTone) strategyLines.push(`dayTone：${replyStrategyContext.dayTone}`)
    if (replyStrategyContext.displayStatus) strategyLines.push(`展示状态：${replyStrategyContext.displayStatus}`)
    if (strategyLines.length) lines.push(strategyLines.join('\n'))
  }
  if (typeof recentInteractionContext === 'string' && normalizeText(recentInteractionContext)) {
    lines.push(recentInteractionContext.trim())
  } else if (recentInteractionContext && typeof recentInteractionContext === 'object') {
    const interactionLines = []
    if (recentInteractionContext.summary) interactionLines.push(`近期互动摘要：${recentInteractionContext.summary}`)
    if (recentInteractionContext.lastConflict) interactionLines.push(`最近冲突/敏感点：${recentInteractionContext.lastConflict}`)
    if (recentInteractionContext.relationshipTrend) interactionLines.push(`关系趋势：${recentInteractionContext.relationshipTrend}`)
    if (interactionLines.length) lines.push(interactionLines.join('\n'))
  }
  return lines.filter(Boolean).join('\n\n')
}

function buildDirectReplyMessages({
  contact = null,
  historyMessages = [],
  currentTurnMessages = [],
  customStickers = [],
  threadContext = null
} = {}) {
  const roleName = normalizeText(contact?.remarkName || contact?.name) || '对方'
  const persona = normalizeText(contact?.persona || contact?.intro)
  const contextMessageCount = Math.max(1, Number(contact?.contextMessageCount || 0)) || 40
  const contextBlock = formatDirectContextBlock(threadContext, contact)
  const includeTimeContext = isTimeAwareEnabled(contact) && isChatTimeAwarenessEnabled(contact)
  const nowTs = Number(
    threadContext?.scheduleContext?.deliveredAt
    || currentTurnMessages[currentTurnMessages.length - 1]?.timestamp
    || Date.now()
  )
  const timezoneContextBlock = buildTimezoneContextBlock({
    enabled: includeTimeContext && isTimezoneAwarenessEnabled(contact),
    nowTs,
    userTimeZone: resolvePromptUserTimeZone(threadContext),
    roleTimeZone: getRoleTimeZone(contact, 'Asia/Shanghai'),
    userLabel: resolvePromptUserLabel(threadContext)
  })
  const timeAndEventBlock = buildDirectTimeAndEventBlock({
    threadContext,
    historyMessages,
    currentTurnMessages,
    includeTimeContext,
    timezoneContextBlock,
    nowTs
  })
  const recentTimelineBlock = formatDirectRecentTimeline(historyMessages, Math.min(contextMessageCount, 8))
  const languageRuleBlock = formatDirectLanguageRuleBlock(contact)
  const speakingRulesBlock = formatDirectSpeakingRulesBlock(contact)
  const stickerList = (Array.isArray(customStickers) ? customStickers : [])
    .map((item) => ({
      name: normalizeText(item?.name),
      desc: normalizeText(item?.desc)
    }))
    .filter((item) => item.name)
    .slice(0, 24)
  const stickerNames = stickerList.map((item) => item.name)
  const history = (Array.isArray(historyMessages) ? historyMessages : [])
    .slice(-contextMessageCount)
    .map((message) => ({
      role: normalizeText(message?.role) === 'user' ? 'user' : 'assistant',
      content: normalizeText(message?.originalText || message?.text || message?.content)
    }))
    .filter((message) => message.content)
  const currentTurnLines = (Array.isArray(currentTurnMessages) ? currentTurnMessages : [])
    .map((message) => describeDirectMessageForPrompt(message))
    .filter(Boolean)
  return [
    {
      role: 'system',
      content: [
        `你正在扮演微信聊天对象「${roleName}」。`,
        persona ? `角色底座：${persona}` : '',
        timeAndEventBlock,
        speakingRulesBlock,
        languageRuleBlock,
        contextBlock ? `持久化角色上下文：\n${contextBlock}` : '',
        recentTimelineBlock,
        '最终输出要求：',
        '- 只输出要直接发给用户的微信内容，不要解释，不要加 JSON，不要加舞台说明。',
        '- 不要加说话人标签或角色名前缀，例如不要输出「[Assistant]:」「Assistant:」「AI:」「角色:」。',
        '- 回复要自然、简短、像真实聊天。',
        '- 如果需要分成多条微信气泡，请每条气泡单独占一行，最多 3 行。',
        '- 当前这一轮用户连续发来的内容才是你这次要整体回应的输入。',
        '- 如果要发表情包，必须严格使用格式 `[表情:名字]`。',
        '- 表情包只允许使用当前可用名单里的名字，禁止编造不存在的名字。',
        stickerNames.length ? `当前可用表情包：${stickerNames.join('、')}` : '当前没有额外表情包可用，请不要输出任何 `[表情:名字]`。',
        ...stickerList.map((item) => `表情包说明：${item.name}${item.desc ? ` - ${item.desc}` : ''}`)
      ].filter(Boolean).join('\n')
    },
    ...history,
    {
      role: 'user',
      content: currentTurnLines.length
        ? `用户这一轮连续发来的内容：\n${currentTurnLines.map((line) => `- ${line}`).join('\n')}`
        : '用户这一轮发来了一条消息，请结合上下文自然回复。'
    }
  ]
}

async function callDirectReplyModel({
  settingsStore = null,
  contact = null,
  historyMessages = [],
  currentTurnMessages = [],
  customStickers = [],
  threadContext = null
} = {}) {
  const endpoint = normalizeChatCompletionEndpoint(settingsStore?.baseUrl)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settingsStore.apiKey}`
    },
    body: JSON.stringify({
      model: settingsStore.model,
      messages: buildDirectReplyMessages({
        contact,
        historyMessages,
        currentTurnMessages,
        customStickers,
        threadContext
      }),
      temperature: 0.8
    })
  })
  if (!response.ok) {
    throw new Error(`wechat_daemon_ai_request_failed:${response.status}`)
  }
  const payload = await response.json()
  const content = normalizeText(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text)
  if (!content) throw new Error('wechat_daemon_ai_empty_reply')
  return {
    type: 'wechat_reply',
    replyText: content
  }
}

export async function probeWechatDaemonAiSettings(env = process.env, {
  binding = null,
  threadContext = null
} = {}) {
  const safeBinding = binding && typeof binding === 'object' ? binding : {}
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : (safeBinding.threadContextSnapshot && typeof safeBinding.threadContextSnapshot === 'object'
      ? safeBinding.threadContextSnapshot
      : {})
  const baseMessages = Array.isArray(safeThreadContext.messages) ? safeThreadContext.messages : []
  const contact = buildRoleContact(safeBinding, safeThreadContext, baseMessages)
  const settingsStore = await hydrateAiSettingsFromBackgroundKey({
    env,
    settingsStore: resolveAiSettings(env, safeThreadContext),
    threadContext: safeThreadContext,
    binding: safeBinding,
    contact
  })
  const error = canUseDirectAiSettings(settingsStore)
    ? ''
    : (normalizeText(settingsStore?.backgroundAiResolutionError) || 'wechat_daemon_ai_settings_missing')
  return {
    ok: !error,
    error,
    userMessage: error ? getWechatDaemonAiResolutionUserMessage(error) : '后台 AI 配置已就绪',
    backgroundDeviceId: normalizeText(
      settingsStore?.backgroundDeviceId
      || safeThreadContext.backgroundDeviceId
      || safeThreadContext.deviceId
    )
  }
}

export function createWechatDaemonAutoReplyHandler(env = process.env) {
  return async function wechatDaemonAutoReplyHandler({
    binding = null,
    inboundUpdates = [],
    outboxStore = null,
    store = null
  } = {}) {
    const safeBinding = binding && typeof binding === 'object' ? binding : {}
    const normalizedInbound = Array.isArray(inboundUpdates)
      ? inboundUpdates.map((item, index) => normalizeInboundUpdate(item, index))
      : []
    if (!safeBinding.threadKey) {
      throw new Error('wechat_daemon_binding_missing')
    }
    if (!normalizedInbound.length) {
      throw new Error('wechat_daemon_inbound_updates_missing')
    }

    const threadContext = await loadThreadContext({
      env,
      binding: safeBinding,
      inboundUpdates: normalizedInbound,
      store,
      outboxStore
    })
    const baseMessages = Array.isArray(threadContext.messages) ? threadContext.messages : []
    const mergedMessages = mergeConversationMessages(baseMessages, normalizedInbound)
    const turnContext = splitCurrentInboundTurn(mergedMessages, normalizedInbound)
    const effectiveMessages = mergedMessages
    const contact = buildRoleContact(safeBinding, threadContext, effectiveMessages)
    const promptInjectionDebug = buildPromptInjectionDebug({
      historyMessages: turnContext.historyMessages,
      currentTurnMessages: turnContext.currentTurnMessages,
      threadContext
    })
    let daemonDebug = buildDaemonDebugState({
      autoBrainConfigured: isAutoBrainSsrEnabled(env),
      fallbackUsed: true,
      route: 'direct_fallback_pending',
      fallbackReason: isAutoBrainSsrEnabled(env)
        ? 'autobrain_not_attempted'
        : 'wechat_daemon_autobrain_ssr_disabled',
      promptInjectionDebug
    })
    const settingsStore = await hydrateAiSettingsFromBackgroundKey({
      env,
      settingsStore: resolveAiSettings(env, threadContext),
      threadContext,
      binding: safeBinding,
      contact
    })
    const canUseDirectProvider = canUseDirectAiSettings(settingsStore)
    if (!canUseDirectProvider) {
      throw new Error(normalizeText(settingsStore?.backgroundAiResolutionError) || 'wechat_daemon_ai_settings_missing')
    }

    let plan = null
    let replyAction = null
    if (canUseDirectProvider) {
      try {
        const sharedModules = await loadSharedModules(env)
        const runtimeProviders = sharedModules.createAutoBrainServerRuntimeProviders({
          env,
          threadContext,
          sharedModules
        })
        const roleStore = buildRoleStore(safeBinding, threadContext, contact)
        const userStore = buildUserStore(threadContext, runtimeProviders, contact)
        plan = await sharedModules.autoBrainService.decideAutoActions({
          settingsStore,
          userStore,
          roleStore,
          momentsStore: buildMomentsStore(threadContext),
          contact,
          messages: { value: effectiveMessages },
          customStickers: Array.isArray(threadContext.customStickers) ? threadContext.customStickers : [],
          avatarPresets: Array.isArray(threadContext.avatarPresets) ? threadContext.avatarPresets : [],
          worldBookEntries: Array.isArray(threadContext.worldBookEntries) ? threadContext.worldBookEntries : [],
          scheduleContext: buildScheduleContext(threadContext, normalizedInbound),
          replyStrategyContext: threadContext.replyStrategyContext && typeof threadContext.replyStrategyContext === 'object'
            ? clone(threadContext.replyStrategyContext)
            : null,
          directVisionMessage: threadContext.directVisionMessage && typeof threadContext.directVisionMessage === 'object'
            ? clone(threadContext.directVisionMessage)
            : null,
          debugSource: 'wechat_daemon_auto_reply',
          runtimeProviders
        })
        replyAction = findReplyAction(plan)
        daemonDebug = replyAction
          ? buildDaemonDebugState({
              autoBrainConfigured: true,
              autoBrainAttempted: true,
              autoBrainSucceeded: true,
              fallbackUsed: false,
              route: 'autobrain_success'
            })
          : buildDaemonDebugState({
              autoBrainConfigured: true,
              autoBrainAttempted: true,
              autoBrainSucceeded: false,
              fallbackUsed: true,
              route: 'autobrain_empty_fallback',
              fallbackReason: 'wechat_daemon_autobrain_no_reply_action',
              promptInjectionDebug
            })
      } catch (error) {
        daemonDebug = buildDaemonDebugState({
          autoBrainConfigured: isAutoBrainSsrEnabled(env),
          autoBrainAttempted: isAutoBrainSsrEnabled(env),
          autoBrainSucceeded: false,
          fallbackUsed: true,
          route: 'autobrain_failed_fallback',
          errorName: normalizeText(error?.name),
          error: normalizeText(error?.message || error),
          errorStack: normalizeText(String(error?.stack || '').split('\n').slice(0, 8).join('\n')),
          fallbackReason: normalizeText(error?.message || error),
          promptInjectionDebug
        })
        if (normalizeText(env.WECHAT_DAEMON_DISABLE_DIRECT_AI_FALLBACK) === '1') {
          throw error
        }
      }
    }

    if (!replyAction) {
      replyAction = await callDirectReplyModel({
        settingsStore,
        contact,
        historyMessages: turnContext.historyMessages,
        currentTurnMessages: turnContext.currentTurnMessages,
        customStickers: Array.isArray(threadContext.customStickers) ? threadContext.customStickers : [],
        threadContext
      })
      daemonDebug = buildDaemonDebugState({
        ...daemonDebug,
        fallbackUsed: true,
        route: normalizeText(daemonDebug.route) || 'direct_fallback_used',
        promptInjectionDebug
      })
    }

    if (!replyAction) {
      throw new Error('wechat_daemon_auto_reply_missing_renderable_reply')
    }
    const outboxMessages = buildOutboxMessages({
      binding: safeBinding,
      inboundUpdates: normalizedInbound,
      replyAction,
      customStickers: Array.isArray(threadContext.customStickers) ? threadContext.customStickers : []
    })
    if (!outboxMessages.length) {
      throw new Error('wechat_daemon_auto_reply_empty_outbox')
    }
    const queuedMessages = []
    for (const message of outboxMessages) {
      const queued = await outboxStore.enqueueMessage(message)
      if (queued?.id) queuedMessages.push(queued)
    }
    if (!queuedMessages.length) {
      throw new Error('wechat_daemon_auto_reply_not_queued')
    }

    if (store && typeof store.appendThreadContextMessages === 'function') {
      const nextThreadMessages = [
        ...normalizedInbound.map((item, index) => buildInboundWechatMessage(item, index)),
        ...buildReplyThreadContextMessages(
          replyAction,
          Array.isArray(threadContext.customStickers) ? threadContext.customStickers : []
        )
      ]
      await store.appendThreadContextMessages(safeBinding.threadKey, nextThreadMessages, {
        updatedAt: Date.now(),
        snapshotPatch: { daemonDebug }
      }).catch((error) => {
        console.warn('[wechat-daemon] append thread context messages failed', {
          threadKey: safeBinding.threadKey,
          error
        })
      })
    }

    return {
      queued: true,
      outboxMessages: queuedMessages,
      actions: Array.isArray(plan?.actions) ? plan.actions : []
    }
  }
}
