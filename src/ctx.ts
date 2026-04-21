import type { PluginConfigAccessor, PluginAuthStore, PluginCacheStore } from "@ericsanchezok/synergy-plugin"

let _config: PluginConfigAccessor
let _auth: PluginAuthStore
let _cache: PluginCacheStore

export function initContext(config: PluginConfigAccessor, auth: PluginAuthStore, cache: PluginCacheStore) {
  _config = config
  _auth = auth
  _cache = cache
}

export function pluginConfig(): PluginConfigAccessor {
  return _config
}

export function pluginAuth(): PluginAuthStore {
  return _auth
}

export function pluginCache(): PluginCacheStore {
  return _cache
}
