<template>
    <div>
        <div v-if="settingsLoaded" class="my-4">
            <!-- Change Password -->
            <template v-if="!settings.disableAuth">
                <p>
                    {{ $t("Current User") }}: <strong>{{ $root.username }}</strong>
                    <button v-if="! settings.disableAuth" id="logout-btn" class="btn btn-danger ms-4 me-2 mb-2" @click="$root.logout">{{ $t("Logout") }}</button>
                </p>

                <h5 class="my-4 settings-subheading">{{ $t("Change Password") }}</h5>
                <form class="mb-3" @submit.prevent="savePassword">
                    <div class="mb-3">
                        <label for="current-password" class="form-label">
                            {{ $t("Current Password") }}
                        </label>
                        <input
                            id="current-password"
                            v-model="password.currentPassword"
                            type="password"
                            class="form-control"
                            autocomplete="current-password"
                            required
                        />
                    </div>

                    <div class="mb-3">
                        <label for="new-password" class="form-label">
                            {{ $t("New Password") }}
                        </label>
                        <input
                            id="new-password"
                            v-model="password.newPassword"
                            type="password"
                            class="form-control"
                            autocomplete="new-password"
                            required
                        />
                    </div>

                    <div class="mb-3">
                        <label for="repeat-new-password" class="form-label">
                            {{ $t("Repeat New Password") }}
                        </label>
                        <input
                            id="repeat-new-password"
                            v-model="password.repeatNewPassword"
                            type="password"
                            class="form-control"
                            :class="{ 'is-invalid': invalidPassword }"
                            autocomplete="new-password"
                            required
                        />
                        <div class="invalid-feedback">
                            {{ $t("passwordNotMatchMsg") }}
                        </div>
                    </div>

                    <div>
                        <button class="btn btn-primary" type="submit">
                            {{ $t("Update Password") }}
                        </button>
                    </div>
                </form>
            </template>

            <section v-if="!settings.disableAuth" aria-labelledby="mcp-keys-heading" class="my-4">
                <h5 id="mcp-keys-heading" class="my-4 settings-subheading">{{ $t("mcpApiKeys") }}</h5>
                <p>{{ $t("mcpApiKeysDescription") }}</p>
                <p class="text-break">{{ $t("mcpConnectionUrl") }}: <code>{{ mcpEndpoint }}</code><br><code>Authorization: Bearer &lt;API key&gt;</code></p>
                <form class="mb-4" @submit.prevent="createMcpKey">
                    <div class="mb-3">
                        <label for="mcp-key-name" class="form-label">{{ $t("mcpKeyName") }}</label>
                        <input id="mcp-key-name" v-model.trim="mcpKeyName" name="mcp-key-name" class="form-control" autocomplete="off" maxlength="100" required :disabled="mcpKeyBusy" />
                    </div>
                    <div class="mb-3">
                        <label for="mcp-key-expiry" class="form-label">{{ $t("mcpKeyExpiry") }}</label>
                        <select id="mcp-key-expiry" v-model.number="mcpKeyExpiry" name="mcp-key-expiry" class="form-select" :disabled="mcpKeyBusy">
                            <option v-for="days in [7, 30, 90, 365]" :key="days" :value="days">{{ $t("mcpKeyDays", { days }) }}</option>
                        </select>
                    </div>
                    <fieldset class="mb-3" :disabled="mcpKeyBusy">
                        <legend class="fs-6">{{ $t("mcpKeyScopes") }}</legend>
                        <div v-for="scope in mcpScopes" :key="scope" class="form-check mb-2">
                            <input :id="'mcp-scope-' + scope" v-model="mcpKeyScopes" name="mcp-key-scopes" class="form-check-input" type="checkbox" :value="scope" :disabled="scope === 'read'" />
                            <label :for="'mcp-scope-' + scope" class="form-check-label">{{ $t('mcpScope' + scope) }}</label>
                        </div>
                    </fieldset>
                    <button class="btn btn-primary" type="submit" :disabled="mcpKeyBusy || mcpKeysLoading">{{ $t(mcpKeyBusy ? "mcpKeySaving" : "mcpKeyCreate") }}</button>
                </form>

                <div v-if="mcpKeyToken" class="alert alert-warning" role="status">
                    <label for="mcp-key-token" class="form-label">{{ $t("mcpKeyCopyOnce") }}</label>
                    <textarea id="mcp-key-token" ref="mcpKeyToken" :value="mcpKeyToken" class="form-control font-monospace mb-2" rows="3" readonly spellcheck="false" autocomplete="off"></textarea>
                    <button class="btn btn-outline-secondary" type="button" @click="mcpKeyToken = ''">{{ $t("mcpKeyDismiss") }}</button>
                </div>

                <p v-if="mcpKeyError" class="text-danger" role="alert">{{ mcpKeyError }}</p>
                <p v-if="mcpKeysLoading" role="status">{{ $t("mcpKeysLoading") }}</p>
                <template v-else>
                    <p v-if="!mcpKeys.length">{{ $t("mcpKeysEmpty") }}</p>
                    <ul v-else class="list-unstyled">
                        <li v-for="key in mcpKeys" :key="key.id" class="border-bottom py-3">
                            <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
                                <div class="text-break">
                                    <strong>{{ key.name }}</strong>
                                    <div>{{ key.scopes.join(', ') }}</div>
                                    <div>{{ $t("mcpKeyExpires", { date: formatMcpKeyDate(key.expiresAt) }) }}</div>
                                    <div v-if="key.revokedAt">{{ $t("mcpKeyRevoked") }}</div>
                                    <div v-else-if="key.expiresAt <= Date.now()">{{ $t("mcpKeyExpired") }}</div>
                                </div>
                                <button v-if="!key.revokedAt" class="btn btn-outline-danger" type="button" :disabled="mcpKeyBusy" :aria-label="$t('mcpKeyRevokeNamed', { name: key.name })" @click="confirmRevokeMcpKey(key)">{{ $t("mcpKeyRevoke") }}</button>
                            </div>
                        </li>
                    </ul>
                    <button class="btn btn-outline-secondary" type="button" :disabled="mcpKeyBusy" @click="loadMcpKeys">{{ $t("mcpKeysRefresh") }}</button>
                </template>
            </section>

            <!-- TODO: Hidden for now -->
            <div v-if="! settings.disableAuth && false" class="mt-5 mb-3">
                <h5 class="my-4 settings-subheading">
                    {{ $t("Two Factor Authentication") }}
                </h5>
                <div class="mb-4">
                    <button
                        class="btn btn-primary me-2"
                        type="button"
                        @click="$refs.TwoFADialog.show()"
                    >
                        {{ $t("2FA Settings") }}
                    </button>
                </div>
            </div>

            <div class="my-4">
                <!-- Advanced -->
                <h5 class="my-4 settings-subheading">{{ $t("Advanced") }}</h5>

                <div class="mb-4">
                    <button v-if="settings.disableAuth" id="enableAuth-btn" class="btn btn-outline-primary me-2 mb-2" @click="enableAuth">{{ $t("Enable Auth") }}</button>
                    <button v-if="! settings.disableAuth" id="disableAuth-btn" class="btn btn-primary me-2 mb-2" @click="confirmDisableAuth">{{ $t("Disable Auth") }}</button>
                </div>
            </div>
        </div>

        <TwoFADialog ref="TwoFADialog" />

        <Confirm ref="confirmRevokeMcpKey" btn-style="btn-danger" :yes-text="$t('mcpKeyRevoke')" :no-text="$t('cancel')" @yes="revokeMcpKey">
            <p class="text-break">{{ $t("mcpKeyRevokeConfirm", { name: mcpKeyToRevoke?.name || '' }) }}</p>
        </Confirm>

        <Confirm ref="confirmDisableAuth" btn-style="btn-danger" :yes-text="$t('I understand, please disable')" :no-text="$t('Leave')" @yes="disableAuth">
            <i18n-t keypath="disableauth.message1" tag="p">
                <template #disableAuth>
                    <strong>{{ $t('disableAuth') }}</strong>
                </template>
            </i18n-t>

            <i18n-t keypath="disableauth.message2" tag="p">
                <template #scenarios>
                    <strong>{{ $t('scenarios') }}</strong>
                </template>
            </i18n-t>

            <p>{{ $t("Please use this option carefully!") }}</p>

            <div class="mb-3">
                <label for="current-password2" class="form-label">
                    {{ $t("Current Password") }}
                </label>
                <input
                    id="current-password2"
                    v-model="password.currentPassword"
                    type="password"
                    class="form-control"
                    required
                />
            </div>
        </Confirm>
    </div>
</template>

<script>
import Confirm from "../../components/Confirm.vue";
import TwoFADialog from "../../components/TwoFADialog.vue";

export default {
    components: {
        Confirm,
        TwoFADialog
    },

    data() {
        return {
            mcpKeys: [],
            mcpScopes: [ "read", "write", "destructive", "secrets" ],
            mcpKeyName: "",
            mcpKeyExpiry: 30,
            mcpKeyScopes: [ "read" ],
            mcpKeyToken: "",
            mcpKeyError: "",
            mcpKeysLoading: false,
            mcpKeyBusy: false,
            mcpKeyToRevoke: null,
            invalidPassword: false,
            password: {
                currentPassword: "",
                newPassword: "",
                repeatNewPassword: "",
            }
        };
    },

    computed: {
        mcpEndpoint() {
            return new URL("/mcp", window.location.href).href;
        },
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        }
    },

    watch: {
        settingsLoaded: {
            immediate: true,
            handler(loaded) {
                if (loaded && !this.settings.disableAuth) {
                    this.loadMcpKeys();
                }
            },
        },
        "settings.disableAuth"(disabled) {
            this.mcpKeyToken = "";
            if (!disabled && this.settingsLoaded) {
                this.loadMcpKeys();
            }
        },
        "password.repeatNewPassword"() {
            this.invalidPassword = false;
        },
    },

    methods: {
        /** Send a key management request with bounded loading and error feedback. */
        requestMcpKeys(event, ...args) {
            return new Promise((resolve, reject) => {
                this.$root.getSocket().timeout(10000).emit(event, ...args, (error, res) => {
                    if (error || !res?.ok) {
                        reject(new Error(error ? this.$t("mcpKeyRequestFailed") : res?.msg || this.$t("mcpKeyRequestFailed")));
                    } else {
                        resolve(res);
                    }
                });
            });
        },

        /** Refresh public metadata for this user's keys. */
        async loadMcpKeys() {
            this.mcpKeysLoading = true;
            this.mcpKeyError = "";
            try {
                const res = await this.requestMcpKeys("listMcpApiKeys");
                this.mcpKeys = res.keys;
            } catch (error) {
                this.mcpKeyError = error.message;
            } finally {
                this.mcpKeysLoading = false;
            }
        },

        /** Create a key and display its token once, without persisting it locally. */
        async createMcpKey() {
            this.mcpKeyBusy = true;
            this.mcpKeyError = "";
            this.mcpKeyToken = "";
            try {
                const res = await this.requestMcpKeys("createMcpApiKey", {
                    name: this.mcpKeyName,
                    expiresInDays: this.mcpKeyExpiry,
                    scopes: this.mcpKeyScopes,
                });
                this.mcpKeyToken = res.token;
                this.mcpKeys.unshift(res.key);
                this.mcpKeyName = "";
                await this.$nextTick();
                this.$refs.mcpKeyToken.focus();
                this.$refs.mcpKeyToken.select();
            } catch (error) {
                this.mcpKeyError = error.message;
            } finally {
                this.mcpKeyBusy = false;
            }
        },

        /** Confirm revocation before invalidating a credential. */
        confirmRevokeMcpKey(key) {
            this.mcpKeyToRevoke = key;
            this.$refs.confirmRevokeMcpKey.show();
        },

        /** Revoke the selected key, then refresh its persisted state. */
        async revokeMcpKey() {
            this.mcpKeyBusy = true;
            this.mcpKeyError = "";
            try {
                await this.requestMcpKeys("revokeMcpApiKey", this.mcpKeyToRevoke.id);
                this.mcpKeyToken = "";
                await this.loadMcpKeys();
            } catch (error) {
                this.mcpKeyError = error.message;
            } finally {
                this.mcpKeyBusy = false;
                this.mcpKeyToRevoke = null;
            }
        },

        /** Format expiry using the user's selected locale. */
        formatMcpKeyDate(timestamp) {
            return new Intl.DateTimeFormat(this.$i18n.locale, {
                dateStyle: "medium",
                timeStyle: "short",
            }).format(timestamp);
        },

        /** Check new passwords match before saving them */
        savePassword() {
            if (this.password.newPassword !== this.password.repeatNewPassword) {
                this.invalidPassword = true;
            } else {
                this.$root
                    .getSocket()
                    .emit("changePassword", this.password, (res) => {
                        this.$root.toastRes(res);
                        if (res.ok) {
                            this.password.currentPassword = "";
                            this.password.newPassword = "";
                            this.password.repeatNewPassword = "";
                        }
                    });
            }
        },

        /** Disable authentication for web app access */
        disableAuth() {
            this.settings.disableAuth = true;

            // Need current password to disable auth
            // Set it to empty if done
            this.saveSettings(() => {
                this.password.currentPassword = "";
                this.$root.username = null;
                this.$root.socketIO.token = "autoLogin";
            }, this.password.currentPassword);
        },

        /** Enable authentication for web app access */
        enableAuth() {
            this.settings.disableAuth = false;
            this.saveSettings();
            this.$root.storage().removeItem("token");
            location.reload();
        },

        /** Show confirmation dialog for disable auth */
        confirmDisableAuth() {
            this.$refs.confirmDisableAuth.show();
        },

    },
};
</script>
