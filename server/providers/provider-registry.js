export function createProviderRegistry() {
  const providers = []
  return {
    register(provider) {
      if (!provider?.id || typeof provider.canHandle !== 'function' || typeof provider.resolve !== 'function') {
        throw new Error('Provider 必须实现 id/canHandle/resolve')
      }
      providers.push(provider)
    },
    pick(url) {
      return providers.find((p) => p.canHandle(url)) || null
    },
    all() {
      return [...providers]
    }
  }
}
