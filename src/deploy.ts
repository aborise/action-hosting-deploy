/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { exec } from "@actions/exec";
import { channel } from "diagnostics_channel";
import * as path from "path";
import * as fs from "fs";

export type SiteDeploy = {
  site: string;
  target?: string;
  url: string;
  expireTime: string;
};

export type ErrorResult = {
  status: "error";
  error: string;
};

export type ChannelSuccessResult = {
  status: "success";
  result: { [key: string]: SiteDeploy };
};

export type ProductionSuccessResult = {
  status: "success";
  result: {
    hosting: string | string[];
  };
};

type DeployConfig = {
  projectId: string;
  target?: string;
  // Optional version specification for firebase-tools. Defaults to `latest`.
  firebaseToolsVersion?: string;
  functions?: string;
};

export type ChannelDeployConfig = DeployConfig & {
  expires: string;
  channelId: string;
};

export type ProductionDeployConfig = DeployConfig & {};

export function interpretChannelDeployResult(
  deployResult: ChannelSuccessResult
): { expireTime: string; urls: string[] } {
  const allSiteResults = Object.values(deployResult.result);

  const expireTime = allSiteResults[0].expireTime;
  const urls = allSiteResults.map((siteResult) => siteResult.url);

  return {
    expireTime,
    urls,
  };
}

async function execWithCredentials(
  args: string[],
  projectId,
  gacFilename,
  opts: { debug?: boolean; firebaseToolsVersion?: string; channelId?: string }
) {
  let deployOutputBuf: Buffer[] = [];
  const debug = opts.debug || false;
  const firebaseToolsVersion = opts.firebaseToolsVersion || "latest";

  try {
    await exec(
      `npx firebase-tools@${firebaseToolsVersion}`,
      [
        ...args,
        ...(projectId ? ["--project", projectId] : []),
        debug
          ? "--debug" // gives a more thorough error message
          : "--json", // allows us to easily parse the output
      ],
      {
        listeners: {
          stdout(data: Buffer) {
            deployOutputBuf.push(data);
          },
        },
        env: {
          ...process.env,
          FIREBASE_DEPLOY_AGENT: "action-hosting-deploy",
          VITE_APP_CHANNEL_ID: opts.channelId ?? "live",
          GOOGLE_APPLICATION_CREDENTIALS: gacFilename, // the CLI will automatically authenticate with this env variable set
        },
      }
    );
  } catch (e) {
    console.log(Buffer.concat(deployOutputBuf).toString("utf-8"));
    console.log(e.message);

    if (!debug) {
      console.log(
        "Retrying deploy with the --debug flag for better error output"
      );
      await execWithCredentials(args, projectId, gacFilename, {
        debug: true,
        firebaseToolsVersion,
      });
    } else {
      throw e;
    }
  }

  return deployOutputBuf.length
    ? deployOutputBuf[deployOutputBuf.length - 1].toString("utf-8")
    : ""; // output from the CLI
}

export async function deployPreview(
  gacFilename: string,
  deployConfig: ChannelDeployConfig
) {
  const {
    projectId,
    channelId,
    target,
    expires,
    firebaseToolsVersion,
    functions,
  } = deployConfig;

  const deploymentText = await execWithCredentials(
    [
      "hosting:channel:deploy",
      channelId,
      ...(target ? ["--only", target] : []),
      ...(expires ? ["--expires", expires] : []),
    ],
    projectId,
    gacFilename,
    { firebaseToolsVersion, channelId }
  );

  const deploymentResult = JSON.parse(deploymentText.trim()) as
    | ChannelSuccessResult
    | ErrorResult;

  if (deploymentResult.status === "success") {
    // rewrite package.json to use a different entry point for main
    // of the form `[originalEntryPoint]-[channelId].js`

    const packageJsonPath = path.join(process.cwd(), "package.json");
    const json = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const originalEntryPoint = json.main.split(".").slice(0, -1).join(".");

    console.log("originalEntryPoint", originalEntryPoint);

    json.main = `${originalEntryPoint}-${channelId}.js`;

    console.log("json.main", json.main);

    fs.writeFileSync(packageJsonPath, JSON.stringify(json, null, 2));

    // read old entry point and extract all exports (export const foo, export let bar, export function baz)
    const entryPoint = path.join(process.cwd(), originalEntryPoint + ".js");
    const entryPointContent = fs.readFileSync(entryPoint, "utf-8");
    const exports = entryPointContent.matchAll(
      /export (const|let|var|function) (\w+)/g
    );

    // write new entry point that exports all exports from old entry point with added channelId
    const newEntryPoint = path.join(
      process.cwd(),
      `${originalEntryPoint}-${channelId}.js`
    );

    const newEntryPointContent = Array.from(exports)
      .map((match) => {
        return `export ${match[2]} as ${
          match[2]
        }${channelId} from './${path.basename(originalEntryPoint)}.js';`;
      })
      .join("\n");

    console.log("newEntryPointContent", newEntryPointContent);

    fs.writeFileSync(newEntryPoint, newEntryPointContent);

    const scopedFunctions = functions
      ? functions
          .split(",")
          .map((f) => f.trim() + channelId)
          .join(",")
      : functions;

    console.log("functions to deploy:", scopedFunctions || "all");

    // Also deploy functions
    await execWithCredentials(
      [
        "deploy",
        "--only",
        `functions${scopedFunctions ? ":" + scopedFunctions : ""}`,
        "--memory 512MiB",
      ],
      projectId,
      gacFilename,
      { firebaseToolsVersion, channelId }
    );
  }

  return deploymentResult;
}

export async function deployProductionSite(
  gacFilename,
  productionDeployConfig: ProductionDeployConfig
) {
  const { projectId, target, firebaseToolsVersion, functions } =
    productionDeployConfig;

  const deploymentText = await execWithCredentials(
    [
      "deploy",
      "--only",
      `hosting${target ? ":" + target : ""},functions${
        functions ? ":" + functions : ""
      }`,
      "--memory 512MiB",
    ],
    projectId,
    gacFilename,
    { firebaseToolsVersion }
  );

  const deploymentResult = JSON.parse(deploymentText) as
    | ProductionSuccessResult
    | ErrorResult;

  return deploymentResult;
}
