// Package kv provides a FoundationDB-backed key-value store for large,
// non-relational content such as lesson transcripts and video watch progress.
package kv

import (
	"encoding/binary"
	"fmt"
	"math"

	fdb "github.com/apple/foundationdb/bindings/go/src/fdb"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
	"github.com/samber/do/v2"

	"example.com/richter/cfg"
	"example.com/richter/internal"
)

// maxValueBytes is FDB's hard limit minus a safety margin.
const maxValueBytes = 90_000

var Package = do.Package(
	do.Lazy(NewKVSvc),
)

func init() {
	Package(internal.Injector)
}

type KVSvc struct {
	db fdb.Database
}

func NewKVSvc(i do.Injector) (*KVSvc, error) {
	c, err := do.Invoke[*cfg.FdbCfg](i)
	if err != nil {
		return nil, fmt.Errorf("FdbCfg: %w", err)
	}
	fdb.MustAPIVersion(c.APIVersion)
	db, err := fdb.OpenDatabase(c.ClusterFile)
	if err != nil {
		return nil, fmt.Errorf("fdb.OpenDatabase: %w", err)
	}
	// Fail fast if coordinator is unreachable (default is no timeout).
	db.Options().SetTransactionTimeout(10_000) // 10 seconds
	return &KVSvc{db: db}, nil
}

// Set stores value under the given namespace + key tuple.
// Values larger than maxValueBytes are transparently split into chunks.
func (s *KVSvc) Set(ns string, key tuple.Tuple, value []byte) error {
	_, err := s.db.Transact(func(tr fdb.Transaction) (any, error) {
		// Delete any previous data for this key so stale chunks don't linger.
		old := tr.Get(s.metaKey(ns, key)).MustGet()
		if old != nil {
			oldN := int(binary.LittleEndian.Uint32(old))
			tr.Clear(s.metaKey(ns, key))
			for i := range oldN {
				tr.Clear(s.chunkKey(ns, key, i))
			}
		}

		chunks := splitBytes(value, maxValueBytes)
		s.setMeta(tr, ns, key, len(chunks))
		for i, chunk := range chunks {
			tr.Set(s.chunkKey(ns, key, i), chunk)
		}
		return nil, nil
	})
	return err
}

// Get retrieves the value for the given namespace + key tuple.
// Returns nil, nil when the key does not exist.
func (s *KVSvc) Get(ns string, key tuple.Tuple) ([]byte, error) {
	result, err := s.db.Transact(func(tr fdb.Transaction) (any, error) {
		metaBytes := tr.Get(s.metaKey(ns, key)).MustGet()
		if metaBytes == nil {
			return []byte(nil), nil
		}
		n := int(binary.LittleEndian.Uint32(metaBytes))
		if n == 1 {
			return tr.Get(s.chunkKey(ns, key, 0)).MustGet(), nil
		}
		futures := make([]fdb.FutureByteSlice, n)
		for i := range futures {
			futures[i] = tr.Get(s.chunkKey(ns, key, i))
		}
		var out []byte
		for _, f := range futures {
			out = append(out, f.MustGet()...)
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, nil
	}
	return result.([]byte), nil
}

// SetFloat64 stores a float64 under the given key (used for watch progress).
func (s *KVSvc) SetFloat64(ns string, key tuple.Tuple, val float64) error {
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(buf, math.Float64bits(val))
	return s.Set(ns, key, buf)
}

// GetFloat64 retrieves a float64. Returns 0 when key does not exist.
func (s *KVSvc) GetFloat64(ns string, key tuple.Tuple) (float64, error) {
	data, err := s.Get(ns, key)
	if err != nil || data == nil {
		return 0, err
	}
	if len(data) != 8 {
		return 0, fmt.Errorf("kv: unexpected float64 size %d", len(data))
	}
	return math.Float64frombits(binary.LittleEndian.Uint64(data)), nil
}

// Delete removes all chunks for a key.
func (s *KVSvc) Delete(ns string, key tuple.Tuple) error {
	_, err := s.db.Transact(func(tr fdb.Transaction) (any, error) {
		metaBytes := tr.Get(s.metaKey(ns, key)).MustGet()
		if metaBytes == nil {
			return nil, nil
		}
		n := int(binary.LittleEndian.Uint32(metaBytes))
		tr.Clear(s.metaKey(ns, key))
		for i := range n {
			tr.Clear(s.chunkKey(ns, key, i))
		}
		return nil, nil
	})
	return err
}

// ── internal helpers ──────────────────────────────────────────────────────────

// metaKey stores chunk count for a logical key.
// Format: (ns, "m", ...key) → 4-byte little-endian uint32
func (s *KVSvc) metaKey(ns string, key tuple.Tuple) fdb.Key {
	t := tuple.Tuple{ns, "m"}
	return append(t.Pack(), key.Pack()...)
}

// chunkKey stores the idx-th chunk of a logical key.
// Format: (ns, "c", ...key, idx)
func (s *KVSvc) chunkKey(ns string, key tuple.Tuple, idx int) fdb.Key {
	t := tuple.Tuple{ns, "c"}
	return append(append(t.Pack(), key.Pack()...), tuple.Tuple{idx}.Pack()...)
}

func (s *KVSvc) setMeta(tr fdb.Transaction, ns string, key tuple.Tuple, n int) {
	buf := make([]byte, 4)
	binary.LittleEndian.PutUint32(buf, uint32(n))
	tr.Set(s.metaKey(ns, key), buf)
}

func splitBytes(data []byte, chunkSize int) [][]byte {
	var chunks [][]byte
	for len(data) > 0 {
		end := min(chunkSize, len(data))
		chunks = append(chunks, data[:end])
		data = data[end:]
	}
	return chunks
}
