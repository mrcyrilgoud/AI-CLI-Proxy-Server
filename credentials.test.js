const { randomUUID } = require('crypto');
const { CredentialStore, SERVICE } = require('./credentials');

const nativeTest = process.env.PROXY_NATIVE_KEYCHAIN_TEST === '1' ? test : test.skip;
nativeTest('native Keychain disposable set/get/replace/delete round trip', () => {
    const store = new CredentialStore(`${SERVICE}.test.${randomUUID()}`);
    const id = 'disposable-api-key';
    try {
        expect(store.get(id)).toBeNull();
        store.set(id, 'disposable-fixture-secret');
        expect(store.get(id)).toBe('disposable-fixture-secret');
        store.set(id, 'replacement-fixture-secret');
        expect(store.get(id)).toBe('replacement-fixture-secret');
        store.delete(id);
        expect(store.get(id)).toBeNull();
    } finally {
        if (store.get(id)) store.delete(id);
    }
});
