const SERVICE = 'AI-CLI-Proxy-Server.api-keys.v1';

class CredentialStore {
    constructor(service = SERVICE) { this.service = service; }
    entry(tool) {
        const { Entry } = require('@napi-rs/keyring');
        return new Entry(this.service, tool);
    }
    get(tool) { return this.entry(tool).getPassword(); }
    set(tool, secret) {
        const entry = this.entry(tool);
        entry.setPassword(secret);
        if (entry.getPassword() !== secret) throw new Error('Credential verification failed');
    }
    delete(tool) { this.entry(tool).deletePassword(); }
}

module.exports = { CredentialStore, SERVICE };
