import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const REPO_URL = 'https://github.com/anjotadena/asterweave';

// The public path depends on the host: GitHub Pages serves this as a project site under
// /asterweave/, while Vercel (and any root-domain host) serves it from /. A baseUrl that does not
// match the host breaks every asset URL, so it is resolved per build rather than hardcoded.
// Vercel sets VERCEL=1 in all of its build environments; DOCUSAURUS_URL and DOCUSAURUS_BASE_URL
// override both explicitly for any other host.
const isVercel = process.env.VERCEL === '1';
const vercelDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;

const siteUrl =
  process.env.DOCUSAURUS_URL ??
  (isVercel && vercelDomain ? `https://${vercelDomain}` : 'https://anjotadena.github.io');

const siteBaseUrl = process.env.DOCUSAURUS_BASE_URL ?? (isVercel ? '/' : '/asterweave/');

const config: Config = {
  title: 'Asterweave',
  tagline: 'Graph paths woven into reliable delivery.',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  url: siteUrl,
  baseUrl: siteBaseUrl,

  // Deployed by .github/workflows/docs.yml via actions/deploy-pages, not `docusaurus deploy`.
  organizationName: 'anjotadena',
  projectName: 'asterweave',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'warn',

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  themes: ['@docusaurus/theme-mermaid', '@easyops-cn/docusaurus-search-local'],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: `${REPO_URL}/edit/main/website/`,
          breadcrumbs: true,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          lastmod: 'date',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/asterweave.png',
    metadata: [
      {
        name: 'description',
        content:
          'Asterweave is a Claude Code plugin that turns feature and defect delivery into an evidence-driven graph with bounded repair loops, repository-aware agents, and issue-to-PR automation.',
      },
    ],
    colorMode: {
      defaultMode: 'light',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Asterweave',
      logo: {
        alt: 'Asterweave logo',
        src: 'img/asterweave.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/architecture/overview',
          position: 'left',
          label: 'Architecture',
        },
        {
          to: '/commands/overview',
          position: 'left',
          label: 'Commands',
        },
        {
          to: '/agents/overview',
          position: 'left',
          label: 'Agents',
        },
        {
          href: REPO_URL,
          position: 'right',
          label: 'GitHub',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Getting started', to: '/getting-started/installation'},
            {label: 'Using Asterweave', to: '/usage/overview'},
            {label: 'Commands', to: '/commands/overview'},
            {label: 'Architecture', to: '/architecture/overview'},
          ],
        },
        {
          title: 'Reference',
          items: [
            {label: 'Agents', to: '/agents/overview'},
            {label: 'Hooks', to: '/hooks/overview'},
            {label: 'Configuration', to: '/configuration/asterweave-json'},
            {label: 'Troubleshooting', to: '/troubleshooting/common-issues'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'GitHub repository', href: REPO_URL},
            {label: 'Issues', href: `${REPO_URL}/issues`},
            {label: 'Releases', href: `${REPO_URL}/releases`},
            {label: 'Contributing', to: '/contributing/development'},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} AT Digital Labs. Asterweave is released under the MIT License.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['json', 'bash', 'powershell', 'diff', 'yaml'],
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: true,
      },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
