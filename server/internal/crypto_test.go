package server

import (
	"bytes"
	"strings"
	"testing"
)

func TestPasswordsUseSaltAndRejectWrongPassword(t *testing.T) {
	a := passwordHash("long test password")
	b := passwordHash("long test password")
	if a == b || !strings.HasPrefix(a, "argon2id$") || !passwordOK("long test password", a) || passwordOK("wrong", a) || passwordOK("x", "broken") {
		t.Fatal("password hashing")
	}
}
func TestRandomKeyEntropyAndDigest(t *testing.T) {
	a, b := token(32), token(32)
	if len(a) != 43 || a == b || bytes.Equal(digest(a), digest(b)) {
		t.Fatal("random token")
	}
	if validPassword("short") || validPassword(strings.Repeat("a", 1025)) || !validPassword("long enough password") {
		t.Fatal("password limits")
	}
}
