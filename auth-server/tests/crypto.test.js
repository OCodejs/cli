import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret, encryptionKey, keyedHash, randomToken, sha256 } from '../src/crypto.js';

test('AES-256-GCM encrypts and decrypts credentials',()=>{
  const key=Buffer.alloc(32,7);
  const encrypted=encryptSecret('ghp-example-never-real',key);
  assert.notEqual(encrypted,'ghp-example-never-real');
  assert.equal(decryptSecret(encrypted,key),'ghp-example-never-real');
});
test('tampered ciphertext is rejected',()=>{
  const encrypted=encryptSecret('secret',Buffer.alloc(32,1));
  const parts=encrypted.split('.');
  parts[2]=Buffer.from('tampered').toString('base64');
  assert.throws(()=>decryptSecret(parts.join('.')));
});
test('encryption key must decode to exactly 32 bytes',()=>{
  assert.throws(()=>encryptionKey('too-short'));
  assert.equal(encryptionKey(Buffer.alloc(32,2).toString('base64')).length,32);
});
test('session hashes are keyed and random session ids are high entropy',()=>{
  const token=randomToken();
  assert.ok(token.length>=40);
  assert.equal(keyedHash(token,'server-secret'),keyedHash(token,'server-secret'));
  assert.notEqual(keyedHash(token,'server-secret'),keyedHash(token,'other-secret'));
  assert.equal(sha256(token),sha256(token));
});
