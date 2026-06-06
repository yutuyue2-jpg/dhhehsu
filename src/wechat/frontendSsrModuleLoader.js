const normalizeText = (value = '') => String(value || '').trim()

const normalizeModulePath = (modulePath = '') => {
  const safeModulePath = normalizeText(modulePath)
  return safeModulePath ? safeModulePath.replace(/\\/g, '/') : ''
}

export async function getFrontendSsrServer() {
  return {
    mode: 'static_module_map'
  }
}

export async function loadFrontendSsrModule(modulePath = '', env = process.env) {
  if (normalizeText(env.WECHAT_DAEMON_DISABLE_VITE_SSR) === '1') {
    throw new Error('wechat_daemon_vite_ssr_disabled')
  }
  const normalizedModulePath = normalizeModulePath(modulePath)
  if (!normalizedModulePath) {
    throw new Error('wechat_daemon_frontend_module_path_missing')
  }
  throw new Error(`wechat_daemon_frontend_module_not_supported:${normalizedModulePath}`)
}
