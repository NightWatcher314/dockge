import assert from "node:assert/strict";
import { test } from "node:test";
import {
    getAgentConnectionMode,
    getDockgeClientType,
    shouldEagerConnectAgents
} from "../agent-connection-mode";

test("dockgectl handshake selects lazy agent connections and advertises the capability", () => {
    const clientType = getDockgeClientType("", {
        clientType: "dockgectl",
    });

    assert.equal(clientType, "cli");
    assert.equal(shouldEagerConnectAgents(clientType), false);
    assert.equal(getAgentConnectionMode(clientType), "lazy");
});

test("browser sessions retain eager agent connections", () => {
    const clientType = getDockgeClientType("", {});

    assert.equal(clientType, "browser");
    assert.equal(shouldEagerConnectAgents(clientType), true);
    assert.equal(getAgentConnectionMode(clientType), undefined);
    assert.equal(getDockgeClientType("", {
        clientType: "cli",
    }), "browser");
    assert.equal(getDockgeClientType("", {
        clientType: "DockgeCtl",
    }), "browser");
    assert.equal(getDockgeClientType("", {
        clientType: "DOCKGECTL",
    }), "browser");
});

test("agent endpoint identity takes precedence over an untrusted client hint", () => {
    const clientType = getDockgeClientType("arch.example:5001", {
        clientType: "dockgectl",
    });

    assert.equal(clientType, "agent");
    assert.equal(shouldEagerConnectAgents(clientType), true);
});
