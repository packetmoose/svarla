---
layout: page
title: Releases
---

<script setup>
import { data as releases } from './releases.data.js'
</script>

# Releases

<div v-if="releases.length === 0">
  <p>No releases yet.</p>
</div>

<div v-for="release of releases" :key="release.url" class="release-entry">
  <div v-html="release.html"></div>
  <hr />
</div>

<style>
.release-entry {
  margin-bottom: 2rem;
}
.release-entry hr {
  margin-top: 2rem;
  border: none;
  border-top: 1px solid var(--vp-c-divider);
}
.release-entry:last-child hr {
  display: none;
}
</style>
