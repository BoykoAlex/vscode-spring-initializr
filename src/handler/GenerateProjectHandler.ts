// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as extract from "extract-zip";
import * as fse from "fs-extra";
import * as path from "path";
import * as vscode from "vscode";
import { instrumentOperationStep, sendInfo } from "vscode-extension-telemetry-wrapper";
import { dependencyManager, IDependenciesItem } from "../DependencyManager";
import { OperationCanceledError } from "../Errors";
import { IValue, ServiceManager } from "../model";
import { artifactIdValidation, downloadFile, groupIdValidation } from "../Utils";
import { getFromInputBox, openDialogForFolder } from "../Utils/VSCodeUI";
import { BaseHandler } from "./BaseHandler";
import { specifyServiceUrl } from "./utils";

const OPEN_IN_NEW_WORKSPACE = "Open";
const OPEN_IN_CURRENT_WORKSPACE = "Add to Workspace";

export interface WizardParams {
    artifactId?: string;
    groupId?: string;
    language?: string;
    projectType?: "maven-project" | "gradle-project";
    packaging?: string;
    bootVersion?: string;
    dependencies?: string[];
    targetFolder?: string;
}

export class GenerateProjectHandler extends BaseHandler {
    private serviceUrl: string;
    private artifactId: string;
    private groupId: string;
    private language: string;
    private projectType: "maven-project" | "gradle-project";
    private packaging: string;
    private bootVersion: string;
    private dependencies: IDependenciesItem;
    private outputUri: vscode.Uri;
    private manager: ServiceManager;

    private defaults: WizardParams;

    constructor(projectType: "maven-project" | "gradle-project", defaults?: WizardParams) {
        super();
        this.projectType = projectType;
        this.defaults = defaults || {};
    }

    protected get failureMessage(): string {
        return "Fail to create a project.";
    }

    public async runSteps(operationId?: string): Promise<void> {

        // Step: service URL
        this.serviceUrl = await instrumentOperationStep(operationId, "serviceUrl", specifyServiceUrl)();
        if (this.serviceUrl === undefined) { throw new OperationCanceledError("Service URL not specified."); }
        this.manager = new ServiceManager(this.serviceUrl);

        // Step: language
        this.language = await instrumentOperationStep(operationId, "Language", specifyLanguage)(this.defaults);
        if (this.language === undefined) { throw new OperationCanceledError("Language not specified."); }

        // Step: Group Id
        this.groupId = await instrumentOperationStep(operationId, "GroupId", specifyGroupId)(this.defaults);
        if (this.groupId === undefined) { throw new OperationCanceledError("GroupId not specified."); }

        // Step: Artifact Id
        this.artifactId = await instrumentOperationStep(operationId, "ArtifactId", specifyArtifactId)(this.defaults);
        if (this.artifactId === undefined) { throw new OperationCanceledError("ArtifactId not specified."); }

        // Step: Packaging
        this.packaging = await instrumentOperationStep(operationId, "Packaging", specifyPackaging)(this.defaults);
        if (this.packaging === undefined) { throw new OperationCanceledError("Packaging not specified."); }

        // Step: bootVersion
        this.bootVersion = await instrumentOperationStep(operationId, "BootVersion", specifyBootVersion)(this.manager);
        if (this.bootVersion === undefined) { throw new OperationCanceledError("BootVersion not specified."); }
        sendInfo(operationId, { bootVersion: this.bootVersion });

        // Step: Dependencies
        this.dependencies = await instrumentOperationStep(operationId, "Dependencies", specifyDependencies)(this.manager, this.bootVersion, this.defaults);
        sendInfo(operationId, { depsType: this.dependencies.itemType, dependencies: this.dependencies.id });

        // Step: Choose target folder
        this.outputUri = await instrumentOperationStep(operationId, "TargetFolder", specifyTargetFolder)(this.defaults, this.artifactId);
        if (this.outputUri === undefined) { throw new OperationCanceledError("Target folder not specified."); }

        // Step: Download & Unzip
        await instrumentOperationStep(operationId, "DownloadUnzip", downloadAndUnzip)(this.downloadUrl, this.outputUri.fsPath);

        dependencyManager.updateLastUsedDependencies(this.dependencies);

        const hasOpenFolder = vscode.workspace.workspaceFolders !== undefined || vscode.workspace.rootPath !== undefined;
        const projectLocation = this.outputUri.fsPath;
        const choice = await specifyOpenMethod(hasOpenFolder, this.outputUri.fsPath);
        if (choice === OPEN_IN_NEW_WORKSPACE) {
            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path.join(projectLocation, this.artifactId)), hasOpenFolder);
        } else if (choice === OPEN_IN_CURRENT_WORKSPACE) {
            if (!vscode.workspace.rootPath || !this.outputUri.fsPath.startsWith(vscode.workspace.rootPath)) {
                if (!vscode.workspace.workspaceFolders.find((workspaceFolder) => workspaceFolder.uri && this.outputUri.fsPath.startsWith(workspaceFolder.uri.fsPath))) {
                    vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders.length, null, { uri: vscode.Uri.file(path.join(projectLocation, this.artifactId)) });
                }
            }
        }
    }

    private get downloadUrl(): string {
        const params: string[] = [
            `type=${this.projectType}`,
            `language=${this.language}`,
            `groupId=${this.groupId}`,
            `artifactId=${this.artifactId}`,
            `packaging=${this.packaging}`,
            `bootVersion=${this.bootVersion}`,
            `baseDir=${this.artifactId}`,
            `dependencies=${this.dependencies.id}`,
        ];
        return `${this.serviceUrl}/starter.zip?${params.join("&")}`;
    }
}

async function specifyLanguage(defaults: WizardParams): Promise<string> {
    let language: string = defaults.language || vscode.workspace.getConfiguration("spring.initializr").get<string>("defaultLanguage");
    if (!language) {
        language = await vscode.window.showQuickPick(
            ["Java", "Kotlin", "Groovy"],
            { ignoreFocusOut: true, placeHolder: "Specify project language." },
        );
    }
    return language && language.toLowerCase();
}

async function specifyGroupId(defaults: WizardParams): Promise<string> {
    const defaultGroupId: string = defaults.groupId || vscode.workspace.getConfiguration("spring.initializr").get<string>("defaultGroupId");
    return await getFromInputBox({
        placeHolder: "e.g. com.example",
        prompt: "Input Group Id for your project.",
        validateInput: groupIdValidation,
        value: defaultGroupId,
    });
}

async function specifyArtifactId(defaults: WizardParams): Promise<string> {
    const defaultArtifactId: string = defaults.artifactId || vscode.workspace.getConfiguration("spring.initializr").get<string>("defaultArtifactId");
    return await getFromInputBox({
        placeHolder: "e.g. demo",
        prompt: "Input Artifact Id for your project.",
        validateInput: artifactIdValidation,
        value: defaultArtifactId,
    });
}

async function specifyPackaging(defaults: WizardParams): Promise<string> {
    let packaging: string = defaults.packaging || vscode.workspace.getConfiguration("spring.initializr").get<string>("defaultPackaging");
    if (!packaging) {
        packaging = await vscode.window.showQuickPick(
            ["JAR", "WAR"],
            { ignoreFocusOut: true, placeHolder: "Specify packaging type." },
        );
    }
    return packaging && packaging.toLowerCase();
}

async function specifyOpenMethod(hasOpenFolder: boolean, projectLocation: string): Promise<string> {
    let openMethod = vscode.workspace.getConfiguration("spring.initializr").get<string>("defaultOpenProjectMethod");
    if (openMethod !== OPEN_IN_CURRENT_WORKSPACE && openMethod !== OPEN_IN_NEW_WORKSPACE) {
        const candidates: string[] = [
            OPEN_IN_NEW_WORKSPACE,
            hasOpenFolder ? OPEN_IN_CURRENT_WORKSPACE : undefined,
        ].filter(Boolean);
        openMethod = await vscode.window.showInformationMessage(`Successfully generated. Location: ${projectLocation}`, ...candidates);
    }
    return openMethod;
}

async function specifyBootVersion(manager: ServiceManager): Promise<string> {
    const bootVersion: { value: IValue, label: string } = await vscode.window.showQuickPick<{ value: IValue, label: string }>(
        // @ts-ignore
        manager.getBootVersions().then(versions => versions.map(v => ({ value: v, label: v.name }))),
        { ignoreFocusOut: true, placeHolder: "Specify Spring Boot version." }
    );
    return bootVersion && bootVersion.value && bootVersion.value.id;
}

async function specifyDependencies(manager: ServiceManager, bootVersion: string, defaults: WizardParams): Promise<IDependenciesItem> {
    let current: IDependenciesItem = null;
    do {
        dependencyManager.selectedIds = defaults.dependencies || [];
        current = await vscode.window.showQuickPick(
            dependencyManager.getQuickPickItems(manager, bootVersion, { hasLastSelected: true }),
            { ignoreFocusOut: true, placeHolder: "Search for dependencies.", matchOnDetail: true, matchOnDescription: true },
        );
        if (current && current.itemType === "dependency") {
            dependencyManager.toggleDependency(current.id);
        }
    } while (current && current.itemType === "dependency");
    if (!current) {
        throw new OperationCanceledError("Canceled on dependency seletion.");
    }
    return current;
}

async function specifyTargetFolder(defaults: WizardParams, projectName: string): Promise<vscode.Uri> {
    const OPTION_CONTINUE: string = "Continue";
    const OPTION_CHOOSE_ANOTHER_FOLDER: string = "Choose another folder";
    const LABEL_CHOOSE_FOLDER: string = "Generate into this folder";
    const MESSAGE_EXISTING_FOLDER: string = `A folder [${projectName}] already exists in the selected folder. Continue to overwrite or Choose another folder?`;

    let outputUri: vscode.Uri = defaults.targetFolder ? vscode.Uri.file(defaults.targetFolder) : await openDialogForFolder({ openLabel: LABEL_CHOOSE_FOLDER });
    while (outputUri && await fse.pathExists(path.join(outputUri.fsPath, projectName))) {
        const overrideChoice: string = await vscode.window.showWarningMessage(MESSAGE_EXISTING_FOLDER, OPTION_CONTINUE, OPTION_CHOOSE_ANOTHER_FOLDER);
        if (overrideChoice === OPTION_CHOOSE_ANOTHER_FOLDER) {
            outputUri = await openDialogForFolder({ openLabel: LABEL_CHOOSE_FOLDER });
        } else {
            break;
        }
    }
    return outputUri;
}

async function downloadAndUnzip(targetUrl: string, targetFolder: string): Promise<void> {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification }, (p: vscode.Progress<{ message?: string }>) => new Promise<void>(
        async (resolve: () => void, reject: (e: Error) => void): Promise<void> => {
            let filepath: string;
            try {
                p.report({ message: "Downloading zip package..." });
                filepath = await downloadFile(targetUrl);
            } catch (error) {
                return reject(error);
            }

            p.report({ message: "Starting to unzip..." });
            extract(filepath, { dir: targetFolder }, (err) => {
                if (err) {
                    return reject(err);
                }
                return resolve();
            });
        },
    ));
}
