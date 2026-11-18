// Copy or overlay this into the pinned upstream Go module. No WhatsApp account needed.
package whatsapp

import (
	"context"
	"os/exec"
	"testing"
	"time"
)

func TestManoloPilotVoiceFormat(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	for _, tc := range []struct {
		name, codec, filename, wantMIME, wantCodec string
	}{
		{"voice-opus", "libopus", "reply.ogg", voiceMessageMIME, "opus"},
		{"ordinary-vorbis", "libvorbis", "reply.ogg", "audio/mp4", "aac"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data, err := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
				"sine=frequency=440:duration=0.5", "-ar", "48000", "-ac", "1", "-c:a", tc.codec, "-f", "ogg", "-").Output()
			if err != nil {
				t.Fatalf("generate synthetic input: %v", err)
			}
			attachment := Attachment{MIME: "audio/ogg", Filename: tc.filename, Data: data}
			if err := convertAttachment(ctx, &attachment); err != nil {
				t.Fatalf("stock Slidge converter: %v", err)
			}
			// Evaluate the same MIME condition used by the upstream outbound send path.
			if attachment.MIME != tc.wantMIME {
				t.Fatalf("MIME = %q, want %q", attachment.MIME, tc.wantMIME)
			}
			// Re-open the result to inspect the converted bytes, not the cached input spec.
			converted := Attachment{Data: attachment.Data}
			spec, err := converted.GetSpec(ctx)
			if err != nil {
				t.Fatalf("inspect resulting media: %v", err)
			}
			if string(spec.AudioCodec) != tc.wantCodec || spec.VideoWidth != 0 || spec.Duration <= 0 {
				t.Fatalf("unexpected output: codec=%q video width=%d duration=%s", spec.AudioCodec, spec.VideoWidth, spec.Duration)
			}
			t.Logf("MIME %s, audio codec %s, no video", attachment.MIME, spec.AudioCodec)
		})
	}
}
