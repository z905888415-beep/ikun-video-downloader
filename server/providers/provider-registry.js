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
    replace(id, provider) {
      if (!provider?.id || provider.id !== id || typeof provider.canHandle !== 'function' || typeof provider.resolve !== 'function') {
        throw new Error('Provider 必须实现匹配的 id/canHandle/resolve')
      }
      const index = providers.findIndex((item) => item.id === id)
      if (index < 0) providers.push(provider)
      else providers.splice(index, 1, provider)
    },
    all() {
      return [...providers]
    }
  }
}
