import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OWNER = process.env.GITHUB_OWNER || "00sebastian0011-netizen";
const TOKEN = process.env.METRICS_TOKEN || process.env.GITHUB_TOKEN || "";
const UPSTREAM_EXCLUDED = new Set(["JARVIS-AGENTE", "OpenDesing-Reprofesional"]);

const BASELINE_PATH = resolve("assets/metrics-baseline.json");
const SVG_PATH = resolve("assets/stats-dashboard.svg");

const GRAPHQL_QUERY = `
query($login: String!) {
  user(login: $login) {
    followers { totalCount }
    starredRepositories { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER) {
      totalCount
      nodes {
        name
        isPrivate
        stargazerCount
        languages(first: 15, orderBy: {field: SIZE, direction: DESC}) {
          edges {
            size
            node { name }
          }
        }
        defaultBranchRef {
          target {
            ... on Commit {
              history { totalCount }
            }
          }
        }
      }
    }
    contributionsCollection {
      totalCommitContributions
      restrictedContributionsCount
      totalPullRequestContributions
      contributionCalendar {
        totalContributions
        weeks {
          firstDay
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}
`;

function esc(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytesMB(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function groupLanguages(langMap) {
  const buckets = [
    { name: "TypeScript", color: "#3178c6", keys: ["TypeScript"], bytes: 0 },
    { name: "JavaScript", color: "#f1e05a", keys: ["JavaScript"], bytes: 0 },
    { name: "PHP", color: "#777bb4", keys: ["PHP"], bytes: 0 },
    { name: "Python", color: "#3572A5", keys: ["Python"], bytes: 0 },
    {
      name: "UI (CSS / SCSS / HTML / Vue)",
      color: "#e34c26",
      keys: ["CSS", "SCSS", "HTML", "Vue", "Mustache", "Astro"],
      bytes: 0,
    },
    { name: "PLpgSQL / SQL", color: "#38bdf8", keys: ["PLpgSQL", "SQL"], bytes: 0 },
    {
      name: "Shell / PowerShell / Infra",
      color: "#3fb950",
      keys: ["PowerShell", "Shell", "Batchfile", "Dockerfile", "Makefile", "Inno Setup", "Gherkin", "Bru", "C#"],
      bytes: 0,
    },
  ];

  for (const [lang, size] of Object.entries(langMap)) {
    const bucket = buckets.find((b) => b.keys.includes(lang)) || buckets[buckets.length - 1];
    bucket.bytes += Number(size) || 0;
  }

  const total = buckets.reduce((acc, b) => acc + b.bytes, 0) || 1;
  return buckets
    .map((b) => ({
      name: b.name,
      color: b.color,
      bytes: b.bytes,
      pct: Number(((b.bytes / total) * 100).toFixed(1)),
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

function computeCalendarMetrics(weeks) {
  const allDays = weeks
    .flatMap((w) => w.contributionDays || [])
    .filter((d) => d.date >= "2026-03-25")
    .sort((a, b) => a.date.localeCompare(b.date));

  let bestStreak = 0;
  let running = 0;
  let activeDays = 0;
  let peakDay = 0;

  for (const d of allDays) {
    if (d.contributionCount > 0) {
      activeDays += 1;
      running += 1;
      if (running > bestStreak) bestStreak = running;
      if (d.contributionCount > peakDay) peakDay = d.contributionCount;
    } else {
      running = 0;
    }
  }

  const weeklySums = weeks
    .filter((w) => (w.firstDay || "") >= "2026-03-22")
    .map((w) => ({
      week: w.firstDay,
      count: (w.contributionDays || []).reduce((s, d) => s + (d.contributionCount || 0), 0),
    }));

  return { activeDays, bestStreak, peakDay, weeklySums };
}

async function fetchGitHubData() {
  if (!TOKEN) return null;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-metrics-updater",
    },
    body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { login: OWNER } }),
  });

  if (!res.ok) {
    console.warn(`GraphQL HTTP ${res.status}; keeping baseline.`);
    return null;
  }
  const payload = await res.json();
  if (payload.errors || !payload.data?.user) {
    console.warn("GraphQL errors:", JSON.stringify(payload.errors || {}));
    return null;
  }
  return payload.data.user;
}

function mergeMetrics(baseline, user) {
  const today = new Date().toISOString().slice(0, 10);
  if (!user) return { ...baseline, updatedAt: today };

  const nodes = user.repositories?.nodes || [];
  const hasPrivateVisibility =
    nodes.some((r) => r.isPrivate) ||
    (user.contributionsCollection?.restrictedContributionsCount || 0) > 0;

  if (!hasPrivateVisibility) {
    const publicRepos = nodes.filter((r) => !r.isPrivate).length;
    const publicStars = nodes.reduce((s, r) => s + (r.stargazerCount || 0), 0);
    return {
      ...baseline,
      publicRepos: Math.max(publicRepos, baseline.publicRepos || 0),
      publicStars: Math.max(publicStars, baseline.publicStars || 0),
      followers: user.followers?.totalCount ?? baseline.followers,
      updatedAt: today,
    };
  }

  const totalRepos = user.repositories?.totalCount || nodes.length;
  const privateRepos = nodes.filter((r) => r.isPrivate).length;
  const publicRepos = totalRepos - privateRepos;
  const publicStars = nodes.reduce((s, r) => s + (r.stargazerCount || 0), 0);
  const branchCommits = nodes
    .filter((r) => !UPSTREAM_EXCLUDED.has(r.name))
    .reduce((s, r) => s + (r.defaultBranchRef?.target?.history?.totalCount || 0), 0);

  const langTotals = {};
  for (const r of nodes) {
    if (UPSTREAM_EXCLUDED.has(r.name)) continue;
    for (const edge of r.languages?.edges || []) {
      const name = edge.node?.name;
      if (!name) continue;
      langTotals[name] = (langTotals[name] || 0) + edge.size;
    }
  }

  const totalCodeBytes = Object.values(langTotals).reduce((a, b) => a + b, 0);
  const cal = computeCalendarMetrics(user.contributionsCollection?.contributionCalendar?.weeks || []);

  return {
    totalRepos,
    privateRepos,
    publicRepos,
    publicStars,
    followers: user.followers?.totalCount ?? baseline.followers ?? 0,
    totalContributions:
      user.contributionsCollection?.contributionCalendar?.totalContributions ||
      baseline.totalContributions,
    branchCommits,
    activeDays: cal.activeDays,
    bestStreak: cal.bestStreak,
    peakDay: cal.peakDay,
    totalCodeBytes,
    languageGroups: groupLanguages(langTotals),
    weeklySums: cal.weeklySums,
    updatedAt: today,
  };
}

function barColor(count, maxCount) {
  if (count <= 0) return "#161b22";
  const ratio = count / (maxCount || 1);
  if (ratio <= 0.25) return "#0e4429";
  if (ratio <= 0.5) return "#006d32";
  if (ratio <= 0.78) return "#26a641";
  return "#39d353";
}

function renderDashboardSvg(m) {
  const weeks = (m.weeklySums || []).slice(-35);
  const maxWeek = Math.max(1, ...weeks.map((w) => w.count));
  const chartW = 390;
  const chartH = 54;
  const step = weeks.length > 0 ? chartW / weeks.length : 11;
  const barW = Math.max(4, Math.floor(step - 3));

  const sparkBars = weeks
    .map((w, i) => {
      const h =
        w.count > 0 ? Math.max(7, Math.round(Math.sqrt(w.count / maxWeek) * chartH)) : 4;
      const x = (24 + i * step).toFixed(1);
      const y = (278 - h).toFixed(1);
      const fill = barColor(w.count, maxWeek);
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2" fill="${fill}"><title>${esc(w.week)}: ${w.count} contribuciones</title></rect>`;
    })
    .join("\n      ");

  const langs = (m.languageGroups || []).slice(0, 7);
  const maxPct = Math.max(1, ...langs.map((l) => l.pct));
  const langRows = langs
    .map((l, idx) => {
      const y = 68 + idx * 32;
      const barMaxW = 212;
      const fillW = Math.max(8, Math.round((l.pct / maxPct) * barMaxW));
      return `
      <g transform="translate(478, ${y})">
        <circle cx="5" cy="-4" r="4" fill="${esc(l.color)}"/>
        <text x="16" y="0" class="sans" font-size="11.5" font-weight="600" fill="#e6edf3">${esc(l.name)}</text>
        <text x="398" y="0" text-anchor="end" class="mono" font-size="10.5" fill="#8b949e">${l.pct.toFixed(1)}% · ${esc(formatBytesMB(l.bytes))}</text>
        <rect x="0" y="7" width="398" height="7" rx="3.5" fill="#161b22"/>
        <rect x="0" y="7" width="${Math.max(12, Math.round((l.pct / 100) * 398))}" height="7" rx="3.5" fill="${esc(l.color)}"/>
      </g>`;
    })
    .join("\n");

  const totalMB = ((m.totalCodeBytes || 0) / (1024 * 1024)).toFixed(1);

  const startMonth = weeks[0]?.week ? weeks[0].week.slice(0, 7) : "2026-03";
  const endMonth = weeks[weeks.length - 1]?.week
    ? weeks[weeks.length - 1].week.slice(0, 7)
    : m.updatedAt.slice(0, 7);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 322" width="900" height="322" role="img" aria-label="Dashboard de telemetría y lenguajes de Yandy Sebastian">
  <defs>
    <style>
      .sans { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
      .mono { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; }
    </style>
  </defs>

  <!-- LEFT PANEL: TELEMETRÍA -->
  <rect x="0.5" y="0.5" width="437" height="321" rx="14" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
  <text x="24" y="30" class="sans" font-size="12.5" font-weight="700" fill="#f0f6fc" letter-spacing="0.6">TELEMETRÍA DE INGENIERÍA</text>
  <rect x="316" y="14" width="98" height="22" rx="6" fill="#11261b" stroke="#3fb950" stroke-opacity="0.45" stroke-width="1"/>
  <text x="365" y="28.5" text-anchor="middle" class="mono" font-size="9.5" font-weight="700" fill="#3fb950">VERIFICADO</text>

  <!-- KPI 2x2 -->
  <rect x="24" y="48" width="188" height="68" rx="10" fill="#161b22" stroke="#26303d" stroke-width="1"/>
  <text x="38" y="75" class="sans" font-size="23" font-weight="800" fill="#58a6ff">${m.totalRepos}</text>
  <text x="38" y="93" class="mono" font-size="10" font-weight="700" fill="#e6edf3">REPOSITORIOS</text>
  <text x="38" y="107" class="mono" font-size="9.5" fill="#8b949e">${m.privateRepos} privados · ${m.publicRepos} públicos</text>

  <rect x="226" y="48" width="188" height="68" rx="10" fill="#161b22" stroke="#26303d" stroke-width="1"/>
  <text x="240" y="75" class="sans" font-size="23" font-weight="800" fill="#3fb950">${m.totalContributions}+</text>
  <text x="240" y="93" class="mono" font-size="10" font-weight="700" fill="#e6edf3">CONTRIBUCIONES</text>
  <text x="240" y="107" class="mono" font-size="9.5" fill="#8b949e">${m.activeDays} días activos · máx ${m.peakDay}/día</text>

  <rect x="24" y="126" width="188" height="68" rx="10" fill="#161b22" stroke="#26303d" stroke-width="1"/>
  <text x="38" y="153" class="sans" font-size="23" font-weight="800" fill="#d2a8ff">${m.branchCommits.toLocaleString("en-US")}+</text>
  <text x="38" y="171" class="mono" font-size="10" font-weight="700" fill="#e6edf3">COMMITS PROPIOS</text>
  <text x="38" y="185" class="mono" font-size="9.5" fill="#8b949e">RPA, Cloud, Desktop &amp; AI</text>

  <rect x="226" y="126" width="188" height="68" rx="10" fill="#161b22" stroke="#26303d" stroke-width="1"/>
  <text x="240" y="153" class="sans" font-size="23" font-weight="800" fill="#e3b341">${m.bestStreak} días</text>
  <text x="240" y="171" class="mono" font-size="10" font-weight="700" fill="#e6edf3">MEJOR RACHA</text>
  <text x="240" y="185" class="mono" font-size="9.5" fill="#8b949e">Desde Mar 2026 · ${m.followers} followers</text>

  <!-- Weekly Sparkbars -->
  <text x="24" y="216" class="mono" font-size="10" font-weight="700" fill="#8b949e">CADENCIA SEMANAL (${esc(startMonth)} → ${esc(endMonth)})</text>
  <line x1="24" y1="282" x2="414" y2="282" stroke="#21262d" stroke-width="1"/>
  ${sparkBars}
  <text x="24" y="301" class="mono" font-size="9.5" fill="#6e7681">Incluye repositorios privados de producción &amp; proyectos públicos</text>

  <!-- RIGHT PANEL: DISTRIBUCIÓN REAL DE LENGUAJES -->
  <rect x="456.5" y="0.5" width="443" height="321" rx="14" fill="#0d1117" stroke="#30363d" stroke-width="1"/>
  <text x="478" y="30" class="sans" font-size="12.5" font-weight="700" fill="#f0f6fc" letter-spacing="0.6">DISTRIBUCIÓN REAL DE CÓDIGO</text>
  <text x="478" y="47" class="mono" font-size="10" fill="#8b949e">Código propio multi-repo (${totalMB} MB · sin plantillas upstream)</text>
  ${langRows}
  <text x="478" y="302" class="mono" font-size="9.5" fill="#6e7681">Actualizado: ${esc(m.updatedAt)} · Auto-sync con GitHub Actions</text>
</svg>
`;
}

async function main() {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  let baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
    : {};

  const user = await fetchGitHubData();
  const merged = mergeMetrics(baseline, user);

  writeFileSync(BASELINE_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
  writeFileSync(SVG_PATH, renderDashboardSvg(merged), "utf8");
  console.log(
    `Updated metrics: repos=${merged.totalRepos}, contribs=${merged.totalContributions}, updatedAt=${merged.updatedAt}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
