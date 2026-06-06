const DEFAULT_WECHAT_ACCOUNT_NAME = '默认账号'

const normalizeText = (value = '') => String(value || '').trim()

const clone = (value) => JSON.parse(JSON.stringify(value))

const createEmptyRelationStore = () => ({
  async ready() {},
  areAcquainted() {
    return false
  }
})

const createEmptyGroupStore = () => ({
  groups: [],
  async ready() {}
})

const createEmptyRoleMediaStore = () => ({
  async ready() {},
  getPrivateAssetsByRoleId() {
    return []
  },
  getSceneAssets() {
    return []
  }
})

function mergeUserInfo(primary = null, fallback = null) {
  const nextPrimary = primary && typeof primary === 'object' ? primary : {}
  const nextFallback = fallback && typeof fallback === 'object' ? fallback : {}
  return {
    ...clone(nextFallback),
    ...clone(nextPrimary)
  }
}

export function createAutoBrainServerRuntimeProviders({
  env = process.env,
  threadContext = null,
  sharedModules = null
} = {}) {
  const safeThreadContext = threadContext && typeof threadContext === 'object'
    ? threadContext
    : {}
  const safeSharedModules = sharedModules && typeof sharedModules === 'object'
    ? sharedModules
    : {}
  const roleMemoryService = safeSharedModules.roleMemoryService && typeof safeSharedModules.roleMemoryService === 'object'
    ? safeSharedModules.roleMemoryService
    : null

  return {
    async ensureTodaySchedule(roleId = '') {
      if (typeof safeThreadContext.ensureTodaySchedule === 'function') {
        await safeThreadContext.ensureTodaySchedule(roleId)
      }
    },

    resolveCurrentWechatAccountName(contact = null) {
      return normalizeText(
        safeThreadContext.wechatAccountName
        || safeThreadContext.accountName
        || contact?.sessionAccountName
        || contact?.accountName
        || contact?.accountId
      ) || DEFAULT_WECHAT_ACCOUNT_NAME
    },

    resolveCurrentWechatUserInfo(contact = null, fallbackUserInfo = null) {
      return mergeUserInfo(
        safeThreadContext.userInfo || safeThreadContext.currentWechatUserInfo || contact?.currentWechatUserInfo || null,
        fallbackUserInfo || null
      )
    },

    getUserTimeZone() {
      return normalizeText(safeThreadContext.userTimeZone || env.TZ || 'Asia/Shanghai')
    },

    getRelationStore() {
      return safeThreadContext.relationStore || createEmptyRelationStore()
    },

    getGroupStore() {
      return safeThreadContext.groupStore || createEmptyGroupStore()
    },

    getFeedPersonas() {
      return Array.isArray(safeThreadContext.feedPersonas) ? safeThreadContext.feedPersonas : []
    },

    async ensureWechatForumIdentityContextReady() {
      if (typeof safeThreadContext.ensureWechatForumIdentityContextReady === 'function') {
        await safeThreadContext.ensureWechatForumIdentityContextReady()
      }
    },

    async loadStoredXContextEvents(accountId = '') {
      if (typeof safeThreadContext.loadStoredXContextEvents === 'function') {
        return safeThreadContext.loadStoredXContextEvents(accountId)
      }
      return Array.isArray(safeThreadContext.xContextEvents) ? safeThreadContext.xContextEvents : []
    },

    async selectMemoryForTurnAsync(options = {}) {
      if (typeof safeThreadContext.selectMemoryForTurnAsync === 'function') {
        return safeThreadContext.selectMemoryForTurnAsync(options)
      }
      if (typeof roleMemoryService?.selectMemoryForTurnAsync === 'function') {
        return roleMemoryService.selectMemoryForTurnAsync(options)
      }
      return {
        activeMemory: [],
        mentionCandidates: [],
        memorySettings: {}
      }
    },

    async getRoleMediaStore() {
      if (safeThreadContext.roleMediaStore) {
        await safeThreadContext.roleMediaStore.ready?.()
        return safeThreadContext.roleMediaStore
      }
      return createEmptyRoleMediaStore()
    },

    getMusicState() {
      return safeThreadContext.musicState && typeof safeThreadContext.musicState === 'object'
        ? safeThreadContext.musicState
        : {
            listeningSession: null,
            listeningTrack: null,
            playMode: ''
          }
    },

    async getChatTriggeredCallAvailability(roleId = '', nowTs = Date.now(), options = {}) {
      if (typeof safeThreadContext.getChatTriggeredCallAvailability === 'function') {
        return safeThreadContext.getChatTriggeredCallAvailability(roleId, nowTs, options)
      }
      if (safeThreadContext.callAvailability && typeof safeThreadContext.callAvailability === 'object') {
        return safeThreadContext.callAvailability
      }
      return {
        state: 'unavailable',
        reason: 'wechat_daemon_server_runtime'
      }
    }
  }
}
