import { createContentLoader } from 'vitepress'

export default createContentLoader('releases/v*.md', {
  render: true,
  transform(rawData) {
    return rawData.sort((a, b) => {
      // Sort by version descending (latest first)
      // Extract version from URL: /releases/vX.Y.Z.html -> X.Y.Z
      const versionA = a.url.match(/v(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/)?.[1] || '0.0.0'
      const versionB = b.url.match(/v(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/)?.[1] || '0.0.0'

      const partsA = versionA.split(/[-.]/)
      const partsB = versionB.split(/[-.]/)

      for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const a = parseInt(partsA[i]) || 0
        const b = parseInt(partsB[i]) || 0
        if (a !== b) return b - a
      }
      return 0
    })
  }
})
