package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"golang.org/x/crypto/argon2"
	"strings"
)

func token(n int) string {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func digest(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }
func passwordHash(p string) string {
	s := token(16)
	h := argon2.IDKey([]byte(p), []byte(s), 3, 64*1024, 2, 32)
	return "argon2id$v=19$m=65536,t=3,p=2$" + s + "$" + base64.RawURLEncoding.EncodeToString(h)
}
func passwordOK(p, h string) bool {
	v := strings.Split(h, "$")
	if len(v) != 5 || v[0] != "argon2id" || v[1] != "v=19" || v[2] != "m=65536,t=3,p=2" {
		return false
	}
	want, e := base64.RawURLEncoding.DecodeString(v[4])
	if e != nil {
		return false
	}
	got := argon2.IDKey([]byte(p), []byte(v[3]), 3, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(want, got) == 1
}
func validPassword(p string) bool { return len(p) >= 12 && len(p) <= 1024 }
