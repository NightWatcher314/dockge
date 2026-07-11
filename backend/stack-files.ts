import fs from "node:fs";
import path from "node:path";

export interface StackFileOwnership {
    uid : number;
    gid : number;
}

export function writeStackFiles(
    dir : string,
    composeFileName : string,
    composeYAML : string,
    composeENV : string,
    ownership? : StackFileOwnership
) {
    const composePath = path.join(dir, composeFileName);
    const envPath = path.join(dir, ".env");

    fs.writeFileSync(composePath, composeYAML);
    if (fs.existsSync(envPath) || composeENV.trim() !== "") {
        fs.writeFileSync(envPath, composeENV);
    }

    if (ownership) {
        fs.lchownSync(dir, ownership.uid, ownership.gid);
        fs.chownSync(composePath, ownership.uid, ownership.gid);
        if (fs.existsSync(envPath)) {
            fs.chownSync(envPath, ownership.uid, ownership.gid);
        }
    }
}
