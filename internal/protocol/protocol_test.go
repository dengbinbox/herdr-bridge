package protocol

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestWireVectors(t *testing.T) {
	b, e := os.ReadFile("../../contracts/bridge/vectors.json")
	if e != nil {
		t.Fatal(e)
	}
	var vectors []struct {
		Name    string `json:"name"`
		ID      string `json:"tunnel_id"`
		Payload string `json:"payload_hex"`
		Wire    string `json:"wire_hex"`
	}
	if e = json.Unmarshal(b, &vectors); e != nil {
		t.Fatal(e)
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			payload, _ := hex.DecodeString(v.Payload)
			want, _ := hex.DecodeString(v.Wire)
			got, e := Encode(v.ID, payload)
			if e != nil || !bytes.Equal(got, want) {
				t.Fatalf("encode: %x %v", got, e)
			}
			id, p, e := Decode(want)
			if e != nil || id != v.ID || !bytes.Equal(p, payload) {
				t.Fatal("decode mismatch")
			}
		})
	}
}
func TestRejectMalformed(t *testing.T) {
	valid, _ := Encode("00112233-4455-6677-8899-aabbccddeeff", nil)
	for n := 0; n < HeaderSize; n++ {
		if _, _, e := Decode(valid[:n]); e == nil {
			t.Fatalf("accepted short header %d", n)
		}
	}
	for _, at := range []int{0, 1} {
		b := append([]byte(nil), valid...)
		b[at] = 99
		if _, _, e := Decode(b); e == nil {
			t.Fatal("accepted unknown version/kind")
		}
	}
	if ValidID("00112233-4455-6677-8899-AABBCCDDEEFF") || ValidID("00000000-0000-0000-0000-000000000000") {
		t.Fatal("noncanonical ID accepted")
	}
	for _, b := range []string{`{"type":"register","version":2}`, `{"type":"bogus","version":1}`, strings.Repeat(" ", 16385), `null`} {
		if _, e := DecodeControl([]byte(b)); e == nil {
			t.Fatal("invalid control accepted")
		}
	}
}
func TestSchemaMatchesControlFields(t *testing.T) {
	b, e := os.ReadFile("../../contracts/bridge/control.schema.json")
	if e != nil {
		t.Fatal(e)
	}
	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if json.Unmarshal(b, &schema) != nil {
		t.Fatal("schema JSON")
	}
	typ := reflect.TypeOf(Control{})
	for i := 0; i < typ.NumField(); i++ {
		name := strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]
		if _, ok := schema.Properties[name]; !ok {
			t.Errorf("missing field %s", name)
		}
		delete(schema.Properties, name)
	}
	if len(schema.Properties) != 0 {
		t.Fatalf("extra schema fields: %v", schema.Properties)
	}
}
func FuzzEnvelope(f *testing.F) {
	f.Add([]byte{1, 1})
	b, _ := Encode("00112233-4455-6677-8899-aabbccddeeff", []byte("hello"))
	f.Add(b)
	f.Fuzz(func(t *testing.T, b []byte) {
		id, p, e := Decode(b)
		if e == nil {
			out, e := Encode(id, p)
			if e != nil || !bytes.Equal(out, b) {
				t.Fatal("not a canonical roundtrip")
			}
		}
	})
}
