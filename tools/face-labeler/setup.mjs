#!/usr/bin/env node

import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TOOL_DIR, "../..")
const DEFAULT_WORKSPACE = path.join(REPO_ROOT, ".media-staging", "faces")

const MODELS = [
  {
    filename: "face_detection_yunet_2023mar.onnx",
    url: "https://github.com/opencv/opencv_zoo/raw/4.10.0/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    bytes: 232_589,
  },
  {
    filename: "face_recognition_sface_2021dec.onnx",
    url: "https://github.com/opencv/opencv_zoo/raw/4.10.0/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    bytes: 38_696_353,
  },
]

main().catch((error) => {
  console.error(`Face-labeler setup failed: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const workspace = path.resolve(options.workspace ?? DEFAULT_WORKSPACE)
  assertPrivateWorkspace(workspace)

  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await chmod(workspace, 0o700)
  const modelDirectory = path.join(workspace, "models")
  await mkdir(modelDirectory, { recursive: true, mode: 0o700 })
  await chmod(modelDirectory, 0o700)

  for (const model of MODELS) {
    await ensureModel(modelDirectory, model, options.check)
  }

  const virtualEnvironment = path.join(workspace, ".venv")
  const python = path.join(virtualEnvironment, "bin", "python")
  if (options.check) {
    if (!(await pathExists(python))) {
      throw new Error("The pinned Python environment is missing; run npm run faces:setup")
    }
    await run(python, [
      "-c",
      "from importlib.metadata import version; "
        + "assert version('numpy') == '2.5.1'; "
        + "assert version('opencv-python-headless') == '4.13.0.92'; "
        + "import cv2, numpy",
    ])
  } else {
    if (!(await pathExists(python))) {
      await run("uv", [
        "venv",
        "--python",
        "3.14",
        virtualEnvironment,
      ])
    }

    await run("uv", [
      "pip",
      "sync",
      "--python",
      python,
      path.join(TOOL_DIR, "requirements.txt"),
    ])
  }

  const summary = {
    workspace,
    models: MODELS.map(({ filename, sha256 }) => ({ filename, sha256 })),
    runtime: options.check ? "checked" : "ready",
  }
  console.log(JSON.stringify(summary, null, 2))
}

function parseArguments(arguments_) {
  const options = { check: false, workspace: undefined }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--check") {
      options.check = true
    } else if (argument === "--workspace") {
      options.workspace = arguments_[index + 1]
      index += 1
    } else if (argument === "--help") {
      console.log("Usage: npm run faces:setup -- [--workspace PATH] [--check]")
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function assertPrivateWorkspace(workspace) {
  const allowedRoot = path.join(REPO_ROOT, ".media-staging")
  const relative = path.relative(allowedRoot, workspace)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Workspace must be a child of the repository's ignored .media-staging directory")
  }
}

async function ensureModel(directory, model, checkOnly) {
  const destination = path.join(directory, model.filename)
  if (await fileMatches(destination, model)) {
    console.log(`Verified ${model.filename}`)
    return
  }
  if (checkOnly) {
    throw new Error(`${model.filename} is missing or does not match its pinned digest`)
  }

  const temporary = `${destination}.partial-${process.pid}`
  await rm(temporary, { force: true })
  try {
    const response = await fetch(model.url, {
      redirect: "follow",
      headers: { "User-Agent": "wedding-face-labeler/1.0" },
    })
    if (!response.ok || !response.body) {
      throw new Error(`Unable to download ${model.filename}: HTTP ${response.status}`)
    }

    const file = await open(temporary, "wx", 0o600)
    try {
      for await (const chunk of response.body) {
        await file.write(chunk)
      }
      await file.sync()
    } finally {
      await file.close()
    }

    if (!(await fileMatches(temporary, model))) {
      throw new Error(`${model.filename} failed size or SHA-256 verification`)
    }
    await rename(temporary, destination)
    await chmod(destination, 0o600)
    console.log(`Downloaded and verified ${model.filename}`)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function fileMatches(filename, model) {
  try {
    const fileStat = await stat(filename)
    if (!fileStat.isFile() || fileStat.size !== model.bytes) return false
    const bytes = await readFile(filename)
    return createHash("sha256").update(bytes).digest("hex") === model.sha256
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

async function pathExists(filename) {
  try {
    const fileStat = await stat(filename)
    return fileStat.isFile()
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: false,
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}
