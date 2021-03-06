const path = require('path')
const fs = require('fs')
const ChildProcess = require('child_process')
const Octokit = require('@octokit/rest')
const octokit = new Octokit()

const semver = require('semver')

process.on('unhandledRejection', reason => {
  console.log(reason)
})

const root = path.dirname(__dirname)
const gitDir = path.join(root, 'git')

/** @returns {Promise<string>} */
function spawn(
  /** @type {string} */ cmd,
  /** @type {Array<string>} */ args,
  /** @type {string} */ cwd
) {
  return new Promise((resolve, reject) => {
    const child = ChildProcess.spawn(cmd, args, { cwd })
    let receivedData = ''

    child.on('error', reject)

    child.stdout.on('data', data => {
      receivedData += data
    })

    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(receivedData)
      } else {
        reject(
          new Error(
            `'${cmd} ${args.join(
              ' '
            )}' exited with code ${code}, signal ${signal}`
          )
        )
      }
    })
  })
}

async function refreshGitSubmodule() {
  await spawn('git', ['fetch', '--tags'], gitDir)
}

async function checkout(/** @type {string} */ tag) {
  await spawn('git', ['checkout', tag], gitDir)
}

async function getLatestStableRelease() {
  const allTags = await spawn('git', ['tag', '--sort=v:refname'], gitDir)

  const releaseTags = allTags
    .split('\n')
    .filter(tag => tag.indexOf('-rc') === -1)
    .filter(tag => semver.valid(tag) !== null)

  const sortedTags = semver.sort(releaseTags)
  const latestTag = sortedTags[sortedTags.length - 1]

  return latestTag.toString()
}

function getPackageDetails(
  /** @type {Array<{name: string, url: string, browser_download_url: string}>} */ assets,
  /** @type {string} */ body,
  /** @type {string} */ arch
) {
  const archValue = arch === 'amd64' ? '64-bit' : '32-bit'

  const minGitFile = assets.find(
    a => a.name.indexOf('MinGit') !== -1 && a.name.indexOf(archValue) !== -1
  )
  if (minGitFile == null) {
    const foundFiles = assets.map(a => a.name)
    console.log(
      `🔴 Could not find ${archValue} archive. Found these files instead: ${JSON.stringify(
        foundFiles
      )}`
    )
    return null
  }

  const filename = minGitFile.name
  const checksumRe = new RegExp(`${filename}\\s*\\|\\s*([0-9a-f]{64})`)
  const match = checksumRe.exec(body)
  if (match == null || match.length !== 2) {
    console.log(
      `🔴 Could not find checksum for ${archValue} archive in release notes body.`
    )
    return null
  }

  return {
    platform: 'windows',
    arch,
    filename,
    url: minGitFile.browser_download_url,
    checksum: match[1],
  }
}

function updateDependencies(
  /** @type {string} */ version,
  /** @type {Array<{platform: string, arch: string, filename: string, url: string, checksum: string}>} */ packages
) {
  const dependenciesPath = path.resolve(__dirname, '..', 'dependencies.json')
  const dependenciesText = fs.readFileSync(dependenciesPath, 'utf8')
  const dependencies = JSON.parse(dependenciesText)

  const git = {
    version: version,
    packages: packages,
  }

  const updatedDependencies = { ...dependencies, git: git }

  const newDepedenciesText = JSON.stringify(updatedDependencies, null, 2)

  fs.writeFileSync(dependenciesPath, newDepedenciesText, 'utf8')
}

async function run() {
  await refreshGitSubmodule()
  const latestGitVersion = await getLatestStableRelease()

  console.log(`✅ Newest git release '${latestGitVersion}'`)

  await checkout(latestGitVersion)

  const token = process.env.GITHUB_ACCESS_TOKEN
  if (token == null) {
    console.log(`🔴 No GITHUB_ACCESS_TOKEN environment variable set`)
    return
  }

  octokit.authenticate({
    type: 'token',
    token,
  })

  const user = await octokit.users.getAuthenticated({})
  const me = user.data.login

  console.log(`✅ Token found for ${me}`)

  const owner = 'git-for-windows'
  const repo = 'git'

  const release = await octokit.repos.getLatestRelease({ owner, repo })

  const { tag_name, body, assets } = release.data
  const version = tag_name

  console.log(`✅ Newest git-for-windows release '${version}'`)

  if (!version.startsWith(latestGitVersion)) {
    console.log(
      `🔴 Latest Git for Windows version is ${version} which is a different series to Git version ${latestGitVersion}`
    )
    return
  }

  const package64bit = getPackageDetails(assets, body, 'amd64')
  const package32bit = getPackageDetails(assets, body, 'x86')

  if (package64bit == null || package32bit == null) {
    return
  }

  updateDependencies(latestGitVersion, [package64bit, package32bit])

  console.log(
    `✅ Updated dependencies metadata to Git ${latestGitVersion} (Git for Windows ${version})`
  )
}

run()
