import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Svarla',
  description: 'A self-hosted softphone for calls and SMS over a data connection',
  srcExclude: ['releases/TEMPLATE.md'],
  ignoreDeadLinks: [
    /localhost/
  ],

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }]
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/what-is-svarla' },
      { text: 'Configuration', link: '/config/server' },
      { text: 'Releases', link: '/releases/' },
      { text: 'GitHub', link: 'https://github.com/packetmoose/svarla' }
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is Svarla?', link: '/guide/what-is-svarla' },
            { text: 'Architecture', link: '/guide/architecture' }
          ]
        },
        {
          text: 'Installation',
          items: [
            { text: 'Installation', link: '/guide/install-docker' },
            { text: 'Building from Source', link: '/guide/install-manual' }
          ]
        },
        {
          text: 'Clients',
          items: [
            { text: 'Android App', link: '/guide/android' },
            { text: 'Web Interface', link: '/guide/web-interface' }
          ]
        },
        {
          text: 'Telephony Providers',
          items: [
            { text: 'Overview', link: '/guide/providers-overview' },
            { text: 'Vonage', link: '/guide/provider-vonage' },
            { text: '46elks', link: '/guide/provider-46elks' },
            { text: 'ModemManager', link: '/guide/provider-modemmanager' }
          ]
        },
        {
          text: 'Security',
          items: [
            { text: 'Verifying Releases', link: '/guide/verify' },
            { text: 'Release Pipeline', link: '/guide/release-pipeline' }
          ]
        }
      ],
      '/config/': [
        {
          text: 'Configuration',
          items: [
            { text: 'Server Config', link: '/config/server' },
            { text: 'MediaBridge Config', link: '/config/mediabridge' },
            { text: 'Port Requirements', link: '/config/ports' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/packetmoose/svarla' }
    ],

    footer: {
      message: 'Released under the AGPL-3.0 License.',
      copyright: '© 2024–2026 Svarla'
    },

    search: {
      provider: 'local'
    }
  }
})
