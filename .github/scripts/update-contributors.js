const fs = require('fs');
const path = require('path');
const https = require('https');

const RC_PATH = path.resolve(__dirname, '../../.all-contributorsrc');
const MD_PATH = path.resolve(__dirname, '../../CONTRIBUTORS.md');

const ICON_MAP = {
  code: { icon: '💻', title: 'Kode Backend / Frontend' },
  doc: { icon: '📖', title: 'Dokumentasi' },
  infra: { icon: '🚇', title: 'Runtime & Infrastruktur' },
  design: { icon: '🎨', title: 'Desain UI / UX' },
  security: { icon: '🛡️', title: 'Audit Keamanan' },
  bug: { icon: '🐛', title: 'Laporan Bug' },
  ideas: { icon: '💡', title: 'Ide & Perencanaan' },
  review: { icon: '👀', title: 'Code Review' },
  maintenance: { icon: '🚧', title: 'Pemeliharaan' },
  test: { icon: '⚠️', title: 'Pengujian' }
};

function fetchGitHubUser(username) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/users/${username}`,
      method: 'GET',
      headers: {
        'User-Agent': 'NodeJS-Contributor-Bot',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {})
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(json.message || `HTTP ${res.statusCode}`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

function renderTable(contributors) {
  const cells = contributors.map(user => {
    const icons = (user.contributions || ['code']).map(key => {
      const entry = ICON_MAP[key.toLowerCase()] || { icon: '✨', title: key };
      return `<a href="https://github.com/myzert/YURIPAY-GOPAY/commits?author=${user.login}" title="${entry.title}">${entry.icon}</a>`;
    }).join(' ');

    const bio = user.bio ? `<br /><small>${user.bio}</small>` : '';

    return `      <td align="center" valign="top" width="180">
        <a href="${user.profile || `https://github.com/${user.login}`}">
          <img src="${user.avatar_url || `https://github.com/${user.login}.png`}" width="100px;" alt="${user.login}" style="border-radius: 50%; box-shadow: 0 4px 10px rgba(0,0,0,0.15);" /><br />
          <sub><b>${user.name || user.login}</b></sub>
        </a>
        <br />
        ${icons}${bio}
      </td>`;
  });

  // Split into rows of 4 columns
  const colsPerRow = 4;
  const rows = [];
  for (let i = 0; i < cells.length; i += colsPerRow) {
    const rowCells = cells.slice(i, i + colsPerRow);
    rows.push(`    <tr>\n${rowCells.join('\n')}\n    </tr>`);
  }

  return `<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table align="center">
  <tbody>
${rows.join('\n')}
  </tbody>
</table>
<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->`;
}

async function main() {
  const action = process.argv[2] || 'generate';
  const username = process.argv[3];
  const contributionsArg = process.argv[4] || 'code,doc';

  const rcData = JSON.parse(fs.readFileSync(RC_PATH, 'utf8'));
  rcData.contributors = rcData.contributors || [];

  if (action === 'add' && username) {
    const cleanUser = username.replace(/^@/, '').trim();
    const contributions = contributionsArg.split(',').map(s => s.trim().toLowerCase());

    const existingIndex = rcData.contributors.findIndex(c => c.login.toLowerCase() === cleanUser.toLowerCase());
    
    let userData = {};
    try {
      userData = await fetchGitHubUser(cleanUser);
    } catch (e) {
      console.warn(`Peringatan: Gagal fetch data GitHub untuk ${cleanUser}: ${e.message}`);
    }

    if (existingIndex >= 0) {
      const existing = rcData.contributors[existingIndex];
      const mergedContributions = Array.from(new Set([...(existing.contributions || []), ...contributions]));
      existing.contributions = mergedContributions;
      if (userData.name) existing.name = userData.name;
      if (userData.avatar_url) existing.avatar_url = userData.avatar_url;
      console.log(`Memperbarui kontributor @${cleanUser} dengan kontribusi: ${mergedContributions.join(', ')}`);
    } else {
      const newContributor = {
        login: cleanUser,
        name: userData.name || cleanUser,
        avatar_url: userData.avatar_url || `https://github.com/${cleanUser}.png`,
        profile: userData.html_url || `https://github.com/${cleanUser}`,
        contributions: contributions
      };
      rcData.contributors.push(newContributor);
      console.log(`Menambahkan kontributor baru @${cleanUser} (${contributions.join(', ')})`);
    }

    fs.writeFileSync(RC_PATH, JSON.stringify(rcData, null, 2) + '\n', 'utf8');
  }

  // Generate markdown in CONTRIBUTORS.md
  if (fs.existsSync(MD_PATH)) {
    let mdContent = fs.readFileSync(MD_PATH, 'utf8');
    const tableHtml = renderTable(rcData.contributors);

    const regex = /<!-- ALL-CONTRIBUTORS-LIST:START[\s\S]*?<!-- ALL-CONTRIBUTORS-LIST:END -->/;
    if (regex.test(mdContent)) {
      mdContent = mdContent.replace(regex, tableHtml);
      fs.writeFileSync(MD_PATH, mdContent, 'utf8');
      console.log(`Berhasil memperbarui ${MD_PATH}`);
    } else {
      console.warn(`Tanda ALL-CONTRIBUTORS-LIST tidak ditemukan di ${MD_PATH}`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
