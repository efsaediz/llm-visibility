import { defineManifest } from '@crxjs/vite-plugin';

const ICONS = {
  '16': 'icon-16.png',
  '32': 'icon-32.png',
  '48': 'icon-48.png',
  '128': 'icon-128.png',
};

export default defineManifest({
  manifest_version: 3,
  name: 'LLM Visibility',
  description:
    'Capture conversations on AI chat interfaces, track brand visibility, attribute answers to cited sources. Open source, local only.',
  version: '0.2.3',
  icons: ICONS,
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'LLM Visibility',
    default_icon: ICONS,
  },
  options_page: 'src/options/index.html',
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['https://chatgpt.com/*'],
      js: ['src/capture/content.ts'],
      run_at: 'document_start',
    },
    {
      matches: ['https://chatgpt.com/*'],
      js: ['src/capture/inject.ts'],
      run_at: 'document_start',
      world: 'MAIN',
    },
  ],
  // Only chatgpt.com — we don't fetch any other origin. Dropping <all_urls>
  // shrinks the permission warning the tester sees in chrome://extensions.
  host_permissions: ['https://chatgpt.com/*'],
  permissions: ['storage', 'unlimitedStorage', 'tabs'],
});
