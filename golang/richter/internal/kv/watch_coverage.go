package kv

import (
	"encoding/binary"
	"fmt"
	"math"
	"math/bits"

	fdb "github.com/apple/foundationdb/bindings/go/src/fdb"
	"github.com/apple/foundationdb/bindings/go/src/fdb/tuple"
)

// nsWatchCov is the KV namespace for per-{user,lesson} watch-coverage bitmaps.
// Each bit i represents whether second-bucket [i, i+1) of the lesson video has
// been watched. The bitmap is stored as a packed byte slice (bit i lives in
// byte i/8, bit i%8) under a single raw key keyed by (sub, lessonID).
//
// A single raw FDB value is used (not the chunked Set/Get path) so the
// read-modify-write can run inside one transaction for atomicity. A bitmap of
// N seconds costs N/8 bytes, so it stays well under FDB's value limit for any
// realistic lesson length (~90 KB ≈ 200 hours of video).
const nsWatchCov = "watch_cov"

// nsWatchCovTs stores the server-side unix-millis timestamp of the FIRST
// AddWatchCoverage call per {user,lesson} (written once), used to bound the
// cumulative coverage budget against real elapsed time (anti-tamper).
const nsWatchCovTs = "watch_cov_ts"

// watchCovKey builds the per-{user,lesson} key tuple for the coverage bitmap.
func watchCovKey(sub, lessonID string) tuple.Tuple {
	return tuple.Tuple{sub, lessonID}
}

// AddWatchCoverage records that the half-open interval [fromSec, toSec) of the
// lesson video was watched, OR-ing the corresponding 1-second buckets into the
// stored coverage bitmap for {sub, lessonID}.
//
// Bits set: floor(fromSec) .. ceil(toSec)-1, clamped to [0, durationSec) when
// durationSec > 0. Returns an error if toSec <= fromSec, or if the reported
// interval is longer than the whole video (toSec-fromSec > durationSec) — both
// indicate a bogus client report that must not pollute honest coverage. When
// durationSec <= 0 the duration is unknown; bits are still recorded (unclamped
// on the high end) so a later WatchCoverageFraction with a known duration can
// use them.
// nowUnixMs is the server's current time in unix milliseconds. maxRate and
// initialGraceSeconds bound the CUMULATIVE coverage (anti-tamper): total marked
// seconds <= initialGraceSeconds + maxRate × real-seconds since the first call.
// maxRate <= 0 disables the limit. Callers pass time.Now().UnixMilli() and the
// AiCfg tunables.
func AddWatchCoverage(kvSvc *KVSvc, sub, lessonID string, fromSec, toSec float64, durationSec int, nowUnixMs int64, maxRate float64, initialGraceSeconds int) error {
	if kvSvc == nil {
		return fmt.Errorf("kv: nil KVSvc")
	}
	if !(toSec > fromSec) {
		return fmt.Errorf("kv: watch coverage requires to (%v) > from (%v)", toSec, fromSec)
	}
	if fromSec < 0 {
		return fmt.Errorf("kv: watch coverage from (%v) must be >= 0", fromSec)
	}
	if durationSec > 0 && (toSec-fromSec) > float64(durationSec) {
		return fmt.Errorf("kv: watch interval %v..%v exceeds duration %d", fromSec, toSec, durationSec)
	}

	from := int(math.Floor(fromSec))
	to := int(math.Ceil(toSec)) // exclusive upper bucket index
	if from < 0 {
		from = 0
	}
	if durationSec > 0 && to > durationSec {
		to = durationSec
	}
	if to <= from {
		return nil
	}

	rawKey := kvSvc.RawKey(nsWatchCov, watchCovKey(sub, lessonID))
	tsKey := kvSvc.RawKey(nsWatchCovTs, watchCovKey(sub, lessonID))
	_, err := kvSvc.Transact(func(tr fdb.Transaction) (any, error) {
		bm := tr.Get(rawKey).MustGet()
		needBytes := (to + 7) / 8
		if len(bm) < needBytes {
			grown := make([]byte, needBytes)
			copy(grown, bm)
			bm = grown
		}
		setBit := func(i int) bool {
			if bm[i/8]&(1<<uint(i%8)) == 0 {
				bm[i/8] |= 1 << uint(i%8)
				return true
			}
			return false
		}

		if maxRate <= 0 {
			// Anti-tamper disabled: record every reported bucket.
			for i := from; i < to; i++ {
				setBit(i)
			}
		} else {
			// CUMULATIVE anti-tamper budget: total marked coverage may not exceed
			// initialGraceSeconds + maxRate × real-seconds elapsed SINCE THE FIRST
			// watch of this {user,lesson}. Bounding the cumulative total (not the
			// per-call delta) means honest viewers never lose coverage to call
			// spacing, clock jitter, batched/late reports, or pauses — only the
			// growth rate is capped, which still defeats one-shot forgery (a single
			// from=0,to=duration claim happens at elapsed≈0 so only ~grace credits).
			// The timestamp is the FIRST-seen time, written once.
			firstSeenMs := nowUnixMs
			if tsBytes := tr.Get(tsKey).MustGet(); len(tsBytes) == 8 {
				firstSeenMs = int64(binary.BigEndian.Uint64(tsBytes))
			} else {
				tsOut := make([]byte, 8)
				binary.BigEndian.PutUint64(tsOut, uint64(nowUnixMs))
				tr.Set(tsKey, tsOut)
			}
			elapsedSec := 0.0
			if d := nowUnixMs - firstSeenMs; d > 0 {
				elapsedSec = float64(d) / 1000.0
			}
			allowedTotal := float64(initialGraceSeconds) + maxRate*elapsedSec
			covered := 0
			for _, b := range bm {
				covered += bits.OnesCount8(b)
			}
			budget := int(allowedTotal) - covered
			for i := from; i < to && budget > 0; i++ {
				if setBit(i) {
					budget--
				}
			}
		}
		tr.Set(rawKey, bm)
		return nil, nil
	})
	return err
}

// WatchCoverageFraction returns the fraction of the [0, durationSec) interval
// that has been marked watched in the stored coverage bitmap for {sub,
// lessonID}: popcount(bits in range) / durationSec.
//
// Returns -1 when durationSec <= 0, signalling "no usable data" so the caller
// can fall back to a client-reported value. The result is clamped to [0, 1].
func WatchCoverageFraction(kvSvc *KVSvc, sub, lessonID string, durationSec int) (float64, error) {
	if durationSec <= 0 {
		return -1, nil
	}
	if kvSvc == nil {
		return -1, fmt.Errorf("kv: nil KVSvc")
	}

	rawKey := kvSvc.RawKey(nsWatchCov, watchCovKey(sub, lessonID))
	res, err := kvSvc.Transact(func(tr fdb.Transaction) (any, error) {
		return tr.Get(rawKey).MustGet(), nil
	})
	if err != nil {
		return -1, err
	}
	bm, _ := res.([]byte)
	if len(bm) == 0 {
		return 0, nil
	}

	// Count watched buckets within [0, durationSec). Whole bytes fully inside
	// the range use a fast popcount; the final partial byte is masked so bits
	// for buckets >= durationSec are not counted.
	watched := 0
	fullBytes := durationSec / 8
	if fullBytes > len(bm) {
		fullBytes = len(bm)
	}
	for i := 0; i < fullBytes; i++ {
		watched += bits.OnesCount8(bm[i])
	}
	if rem := durationSec % 8; rem != 0 && fullBytes < len(bm) {
		mask := byte((1 << uint(rem)) - 1)
		watched += bits.OnesCount8(bm[fullBytes] & mask)
	}

	frac := float64(watched) / float64(durationSec)
	if frac < 0 {
		frac = 0
	}
	if frac > 1 {
		frac = 1
	}
	return frac, nil
}
