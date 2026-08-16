---
layout: page
title: Releases
---

<script setup>
import { data as releases } from './releases.data.js'
</script>

<div class="releases-page">
  <h1>Releases</h1>

  <div v-if="releases.length === 0" class="no-releases">
    <p>No releases yet.</p>
  </div>

  <article v-for="release of releases" :key="release.url" class="release-entry">
    <div class="vp-doc" v-html="release.html"></div>
  </article>
</div>

<style>
.releases-page {
  max-width: 768px;
  margin: 0 auto;
  padding: 48px 24px;
}

.releases-page > h1 {
  font-size: 2rem;
  font-weight: 700;
  margin-bottom: 2.5rem;
  letter-spacing: -0.02em;
}

.no-releases {
  color: var(--vp-c-text-2);
}

.release-entry {
  position: relative;
  padding: 1.5rem 0;
  border-bottom: 1px solid var(--vp-c-divider);
}

.release-entry:first-of-type {
  padding-top: 0;
}

.release-entry:last-of-type {
  border-bottom: none;
}

.release-entry .vp-doc h1 {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0 0 0.5rem 0;
  padding-top: 0;
  border-top: none;
  letter-spacing: -0.01em;
}

.release-entry .vp-doc h2 {
  font-size: 1rem;
  font-weight: 600;
  margin: 1.25rem 0 0.5rem 0;
  padding-top: 0;
  border-top: none;
  color: var(--vp-c-text-2);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.release-entry .vp-doc p {
  margin: 0.5rem 0;
  color: var(--vp-c-text-1);
  line-height: 1.7;
}

.release-entry .vp-doc ul {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}

.release-entry .vp-doc li {
  margin: 0.25rem 0;
  color: var(--vp-c-text-1);
  line-height: 1.6;
}

.release-entry .vp-doc li::marker {
  color: var(--vp-c-brand-1);
}

.release-entry .vp-doc code {
  font-size: 0.875em;
  color: var(--vp-c-brand-1);
  background-color: var(--vp-c-brand-soft);
  border-radius: 4px;
  padding: 0.15em 0.4em;
}
</style>
