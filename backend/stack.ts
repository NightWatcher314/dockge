import { DockgeServer } from "./dockge-server";
import fs, { promises as fsAsync } from "fs";
import { log } from "./log";
import yaml from "yaml";
import { DockgeSocket, fileExists, ValidationError } from "./util-server";
import path from "path";
import {
    acceptedComposeFileNames,
    COMBINED_TERMINAL_COLS,
    COMBINED_TERMINAL_ROWS,
    CREATED_FILE,
    getCombinedTerminalName,
    getComposeTerminalName, getContainerExecTerminalName,
    PROGRESS_TERMINAL_ROWS,
    TERMINAL_ROWS,
    UNKNOWN
} from "../common/util-common";
import { InteractiveTerminal, Terminal } from "./terminal";
import childProcessAsync from "promisify-child-process";
import { Settings } from "./settings";
import { writeStackFiles } from "./stack-files";
import { execFile } from "node:child_process";
import { readContainerStates, serviceState, stackPolicy, summarizeStack } from "./stack-status";
import { parse as parseDotenv } from "dotenv";

export class Stack {

    name: string;
    protected _status: number = UNKNOWN;
    hasActiveContainers?: boolean;
    protected _composeYAML?: string;
    protected _composeENV?: string;
    protected _configFilePath?: string;
    protected _composeFileName: string = "compose.yaml";
    protected server: DockgeServer;

    protected combinedTerminal? : Terminal;

    protected static managedStackList: Map<string, Stack> = new Map();

    constructor(server : DockgeServer, name : string, composeYAML? : string, composeENV? : string, skipFSOperations = false) {
        this.name = name;
        this.server = server;
        this._composeYAML = composeYAML;
        this._composeENV = composeENV;

        if (!skipFSOperations) {
            // Check if compose file name is different from compose.yaml
            for (const filename of acceptedComposeFileNames) {
                if (fs.existsSync(path.join(this.path, filename))) {
                    this._composeFileName = filename;
                    break;
                }
            }
        }
    }

    async toJSON(endpoint : string) : Promise<object> {

        // Since we have multiple agents now, embed primary hostname in the stack object too.
        let primaryHostname = await Settings.get("primaryHostname");
        if (!primaryHostname) {
            if (!endpoint) {
                primaryHostname = "localhost";
            } else {
                // Use the endpoint as the primary hostname
                try {
                    primaryHostname = (new URL("https://" + endpoint).hostname);
                } catch (e) {
                    // Just in case if the endpoint is in a incorrect format
                    primaryHostname = "localhost";
                }
            }
        }

        let obj = this.toSimpleJSON(endpoint);
        return {
            ...obj,
            composeYAML: this.composeYAML,
            composeENV: this.composeENV,
            primaryHostname,
        };
    }

    toSimpleJSON(endpoint : string) : object {
        return {
            name: this.name,
            status: this._status,
            hasActiveContainers: this.hasActiveContainers,
            tags: [],
            isManagedByDockge: this.isManagedByDockge,
            composeFileName: this._composeFileName,
            endpoint,
        };
    }

    /**
     * Get the status of the stack from `docker compose ps --format json`
     */
    async ps() : Promise<object> {
        let res = await childProcessAsync.spawn("docker", this.getComposeOptions("ps", "--format", "json"), {
            cwd: this.path,
            encoding: "utf-8",
        });
        if (!res.stdout) {
            return {};
        }
        return JSON.parse(res.stdout.toString());
    }

    /** One bounded, non-streaming log request; no terminal session or shell. */
    async boundedLogs(tail = 200, since?: string) : Promise<string> {
        if (!Number.isInteger(tail) || tail < 0 || tail > 1000 || (since !== undefined && !Number.isFinite(Date.parse(since)))) {
            throw new ValidationError("Invalid log options");
        }
        const args = this.getComposeOptions("logs", "--no-color", "--timestamps", "--tail", String(tail));
        if (since !== undefined) {
            args.push("--since", new Date(since).toISOString());
        }
        return new Promise((resolve, reject) => {
            execFile("docker", args, {
                cwd: this.path,
                encoding: "utf8",
                timeout: 10000,
                maxBuffer: 1024 * 1024,
                killSignal: "SIGKILL",
            }, (error, stdout) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(stdout);
                }
            });
        });
    }

    get isManagedByDockge() : boolean {
        return fs.existsSync(this.path) && fs.statSync(this.path).isDirectory();
    }

    get status() : number {
        return this._status;
    }

    validate() {
        // Check name, allows [a-z][0-9] _ - only
        if (!this.name.match(/^[a-z0-9_-]+$/)) {
            throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
        }

        // Check YAML format
        yaml.parse(this.composeYAML);

        let lines = this.composeENV.split("\n");

        // Check if the .env is able to pass docker-compose
        // Prevent "setenv: The parameter is incorrect"
        // It only happens when there is one line and it doesn't contain "="
        if (lines.length === 1 && !lines[0].includes("=") && lines[0].length > 0) {
            throw new ValidationError("Invalid .env format");
        }
    }

    get composeYAML() : string {
        if (this._composeYAML === undefined) {
            try {
                this._composeYAML = fs.readFileSync(path.join(this.path, this._composeFileName), "utf-8");
            } catch (e) {
                this._composeYAML = "";
            }
        }
        return this._composeYAML;
    }

    get composeENV() : string {
        if (this._composeENV === undefined) {
            try {
                this._composeENV = fs.readFileSync(path.join(this.path, ".env"), "utf-8");
            } catch (e) {
                this._composeENV = "";
            }
        }
        return this._composeENV;
    }

    get path() : string {
        return path.join(this.server.stacksDir, this.name);
    }

    get fullPath() : string {
        let dir = this.path;

        // Compose up via node-pty
        let fullPathDir;

        // if dir is relative, make it absolute
        if (!path.isAbsolute(dir)) {
            fullPathDir = path.join(process.cwd(), dir);
        } else {
            fullPathDir = dir;
        }
        return fullPathDir;
    }

    /**
     * Save the stack to the disk
     * @param isAdd
     * @param beforeWrite Optional synchronous concurrency gate after filesystem checks.
     */
    async save(isAdd : boolean, beforeWrite? : () => void) {
        this.validate();

        let dir = this.path;

        // Check if the name is used if isAdd
        if (isAdd) {
            if (await fileExists(dir)) {
                throw new ValidationError("Stack name already exists");
            }

            beforeWrite?.();

            // Create the stack folder
            await fsAsync.mkdir(dir);
        } else {
            if (!await fileExists(dir)) {
                throw new ValidationError("Stack not found");
            }
            beforeWrite?.();
        }

        // Write or overwrite the compose.yaml and stack .env.
        const ownership = process.env.PUID && process.env.PGID ? {
            uid: Number(process.env.PUID),
            gid: Number(process.env.PGID),
        } : undefined;
        writeStackFiles(dir, this._composeFileName, this.composeYAML, this.composeENV, ownership);
    }

    async deploy(socket : DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to deploy, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async delete(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("down", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to delete, please check the terminal output for more information.");
        }

        // Remove the stack folder
        await fsAsync.rm(this.path, {
            recursive: true,
            force: true
        });

        return exitCode;
    }

    async updateStatus() {
        const stacks = await Stack.getStackList(this.server, true);
        const stack = stacks.get(this.name);
        this._status = stack?.status ?? UNKNOWN;
        this.hasActiveContainers = stack?.hasActiveContainers;
    }

    /** Use the same known profile configuration as Docker Compose, without expanding secrets. */
    getStatusPolicy(composeYAML?: string, composeENV?: string) {
        if (!this.isManagedByDockge) {
            return stackPolicy();
        }
        try {
            const profilesFromFile = (filename: string) => {
                try {
                    return parseDotenv(fs.readFileSync(filename))["COMPOSE_PROFILES"];
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                        return undefined;
                    }
                    throw error;
                }
            };
            const globalProfiles = profilesFromFile(path.join(this.server.stacksDir, "global.env"));
            const localProfiles = composeENV === undefined ? profilesFromFile(path.join(this.path, ".env")) : parseDotenv(composeENV)["COMPOSE_PROFILES"];
            const configured = process.env.COMPOSE_PROFILES ?? localProfiles ?? globalProfiles ?? "";
            const profiles = configured.split(",").map((profile) => profile.trim()).filter(Boolean);
            const policy = stackPolicy(composeYAML ?? fs.readFileSync(path.join(this.path, this._composeFileName), "utf-8"), profiles);
            if (configured.includes("$") || profiles.some((profile) => !/^(\*|[a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.test(profile))) {
                policy.known = false;
            }
            return policy;
        } catch {
            return stackPolicy("");
        }
    }

    /**
     * Checks if a compose file exists in the specified directory.
     * @async
     * @static
     * @param {string} stacksDir - The directory of the stack.
     * @param {string} filename - The name of the directory to check for the compose file.
     * @returns {Promise<boolean>} A promise that resolves to a boolean indicating whether any compose file exists.
     */
    static async composeFileExists(stacksDir : string, filename : string) : Promise<boolean> {
        let filenamePath = path.join(stacksDir, filename);
        // Check if any compose file exists
        for (const filename of acceptedComposeFileNames) {
            let composeFile = path.join(filenamePath, filename);
            if (await fileExists(composeFile)) {
                return true;
            }
        }
        return false;
    }

    static async getStackList(server : DockgeServer, useCacheForManaged = false) : Promise<Map<string, Stack>> {
        let stacksDir = server.stacksDir;
        let stackList : Map<string, Stack>;

        // Use cached stack list?
        if (useCacheForManaged && this.managedStackList.size > 0 && [ ...this.managedStackList.values() ].every((stack) => stack.server === server)) {
            stackList = new Map(this.managedStackList);
        } else {
            stackList = new Map<string, Stack>();

            // Scan the stacks directory, and get the stack list
            let filenameList = await fsAsync.readdir(stacksDir);

            for (let filename of filenameList) {
                try {
                    // Check if it is a directory
                    let stat = await fsAsync.stat(path.join(stacksDir, filename));
                    if (!stat.isDirectory()) {
                        continue;
                    }
                    // If no compose file exists, skip it
                    if (!await Stack.composeFileExists(stacksDir, filename)) {
                        continue;
                    }
                    let stack = await this.getStack(server, filename);
                    stack._status = CREATED_FILE;
                    stackList.set(filename, stack);
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("getStackList", `Failed to get stack ${filename}, error: ${e.message}`);
                    }
                }
            }

            // Cache by copying
            this.managedStackList = new Map(stackList);
        }

        // compose ls discovers external projects; container snapshots alone determine status.
        let discoveryOK = false;
        try {
            const res = await childProcessAsync.spawn("docker", [ "compose", "ls", "--all", "--format", "json" ], {
                encoding: "utf-8",
                timeout: 10000,
                maxBuffer: 1024 * 1024,
            });
            if (res.code !== 0) {
                throw new Error("Failed to list Compose projects");
            }
            const composeList = JSON.parse(res.stdout?.toString() || "[]");
            for (const composeStack of composeList) {
                if (typeof composeStack.Name !== "string") {
                    throw new Error("Invalid Compose project");
                }
                let stack = stackList.get(composeStack.Name);
                if (!stack) {
                    if (composeStack.Name === "dockge") {
                        continue;
                    }
                    stack = new Stack(server, composeStack.Name);
                    stackList.set(composeStack.Name, stack);
                }
                stack._configFilePath = composeStack.ConfigFiles;
            }
            discoveryOK = true;
        } catch (e) {
            log.warn("getStackList", "Failed to discover Compose projects");
        }

        // Clear cached green states before every read, including Docker failure/deletion races.
        for (const stack of stackList.values()) {
            stack._status = UNKNOWN;
            stack.hasActiveContainers = undefined;
        }
        try {
            const containers = await readContainerStates();
            for (const stack of stackList.values()) {
                const items = containers.filter((container) => container.project === stack.name);
                const policy = stack.getStatusPolicy();
                const summary = summarizeStack(items, policy);
                stack._status = !discoveryOK ? UNKNOWN : items.length === 0 && policy.known && stack.isManagedByDockge ? CREATED_FILE : summary.status;
                stack.hasActiveContainers = summary.hasActiveContainers;
            }
        } catch (e) {
            log.warn("getStackList", "Failed to read container status");
        }
        return stackList;
    }

    /** All entry points use the same container and Compose policy semantics. */
    static async getStatusList(server: DockgeServer) : Promise<Map<string, number>> {
        return new Map([ ...await this.getStackList(server, true) ].map(([ name, stack ]) => [ name, stack.status ]));
    }

    static async getStack(server: DockgeServer, stackName: string, skipFSOperations = false) : Promise<Stack> {
        let dir = path.join(server.stacksDir, stackName);

        if (!skipFSOperations) {
            if (!await fileExists(dir) || !(await fsAsync.stat(dir)).isDirectory()) {
                // Maybe it is a stack managed by docker compose directly
                let stackList = await this.getStackList(server, true);
                let stack = stackList.get(stackName);

                if (stack) {
                    return stack;
                } else {
                    // Really not found
                    throw new ValidationError("Stack not found");
                }
            }
        } else {
            //log.debug("getStack", "Skip FS operations");
        }

        let stack : Stack;

        if (!skipFSOperations) {
            stack = new Stack(server, stackName);
        } else {
            stack = new Stack(server, stackName, undefined, undefined, true);
        }

        stack._status = UNKNOWN;
        stack._configFilePath = path.resolve(dir);
        return stack;
    }

    getComposeOptions(command : string, ...extraOptions : string[]) {
        //--env-file ./../global.env --env-file .env
        let options = [ "compose", command, ...extraOptions ];
        if (fs.existsSync(path.join(this.server.stacksDir, "global.env"))) {
            if (fs.existsSync(path.join(this.path, ".env"))) {
                options.splice(1, 0, "--env-file", "./.env");
            }
            options.splice(1, 0, "--env-file", "../global.env");
        }
        console.log(options);
        return options;
    }

    async start(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to start, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async stop(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("stop"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to stop, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async restart(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("restart"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async down(socket: DockgeSocket) : Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("down"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to down, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async update(socket: DockgeSocket) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        let exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("pull"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to pull, please check the terminal output for more information.");
        }

        // Keep stopped stacks stopped; active abnormal/partial stacks still need rebuilding.
        await this.updateStatus();
        log.debug("update", "Status: " + this.status);
        if (!this.hasActiveContainers) {
            return exitCode;
        }

        exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", this.getComposeOptions("up", "-d", "--remove-orphans"), this.path);
        if (exitCode !== 0) {
            throw new Error("Failed to restart, please check the terminal output for more information.");
        }
        return exitCode;
    }

    async joinCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getOrCreateTerminal(this.server, terminalName, "docker", this.getComposeOptions("logs", "-f", "--tail", "100"), this.path);
        terminal.enableKeepAlive = true;
        terminal.rows = COMBINED_TERMINAL_ROWS;
        terminal.cols = COMBINED_TERMINAL_COLS;
        terminal.join(socket);
        terminal.start();
    }

    async leaveCombinedTerminal(socket: DockgeSocket) {
        const terminalName = getCombinedTerminalName(socket.endpoint, this.name);
        const terminal = Terminal.getTerminal(terminalName);
        if (terminal) {
            terminal.leave(socket);
        }
    }

    async joinContainerTerminal(socket: DockgeSocket, serviceName: string, shell : string = "sh", index: number = 0) {
        const terminalName = getContainerExecTerminalName(socket.endpoint, this.name, serviceName, index);
        let terminal = Terminal.getTerminal(terminalName);

        if (!terminal) {
            terminal = new InteractiveTerminal(this.server, terminalName, "docker", this.getComposeOptions("exec", serviceName, shell), this.path);
            terminal.rows = TERMINAL_ROWS;
            log.debug("joinContainerTerminal", "Terminal created");
        }

        terminal.join(socket);
        terminal.start();
    }

    async getServiceStatusList(strict = false) {
        const statusList = new Map<string, Array<object>>();
        try {
            const containers = await readContainerStates(this.name);
            const policy = this.getStatusPolicy();
            const items = containers.filter((container) => container.project === this.name);
            const summary = summarizeStack(items, policy);
            this._status = summary.status;
            this.hasActiveContainers = summary.hasActiveContainers;
            for (const container of items) {
                if (!statusList.has(container.service)) {
                    statusList.set(container.service, []);
                }
                statusList.get(container.service)?.push({
                    status: serviceState(container, policy),
                    name: container.name,
                });
            }
            return statusList;
        } catch (e) {
            this._status = UNKNOWN;
            this.hasActiveContainers = undefined;
            if (strict) {
                throw e;
            }
            log.error("getServiceStatusList", e);
            return statusList;
        }
    }

    async startService(socket: DockgeSocket, serviceName: string) {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "up", "-d", serviceName ], this.path);
        if (exitCode !== 0) {
            throw new Error(`Failed to start service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async stopService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "stop", serviceName ], this.path);
        if (exitCode !== 0) {
            throw new Error(`Failed to stop service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }

    async restartService(socket: DockgeSocket, serviceName: string): Promise<number> {
        const terminalName = getComposeTerminalName(socket.endpoint, this.name);
        const exitCode = await Terminal.exec(this.server, socket, terminalName, "docker", [ "compose", "restart", serviceName ], this.path);
        if (exitCode !== 0) {
            throw new Error(`Failed to restart service ${serviceName}, please check logs for more information.`);
        }

        return exitCode;
    }
}
