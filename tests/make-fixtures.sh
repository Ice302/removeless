#!/bin/bash
# Generates the test media used by the quality tests and the self-test (macOS: uses `say`).
#   clean.wav  – synthetic speech (ground truth)
#   noisy.wav  – speech + pink noise + 60/180 Hz hum + low rumble
#   person.jpg – portrait photo (Pexels, free licence) for matte tests
#   test_street.mp4 – 1280×720 30 fps animated portrait with noisy.wav
set -e
OUT="${1:-tests/fixtures}"; mkdir -p "$OUT"; cd "$OUT"
FF="$(node -p "require('ffmpeg-static')")"
curl -sL -o person.jpg "https://images.pexels.com/photos/5965592/pexels-photo-5965592.jpeg?auto=compress&cs=tinysrgb&w=1280"
say -v Samantha -o speech.aiff "Hi, I'm recording this on a busy street corner. Traffic is loud, there is an air conditioner humming behind me, and the wind keeps picking up. If you can hear my voice clearly, the isolator is doing its job. Let's test some sibilant words: sixty-six silly snakes, sliding swiftly south."
"$FF" -v error -y -i speech.aiff -ar 48000 -ac 1 clean.wav
"$FF" -v error -y -i clean.wav \
  -f lavfi -i "anoisesrc=color=pink:amplitude=0.12:sample_rate=48000" \
  -f lavfi -i "sine=frequency=60:sample_rate=48000" -f lavfi -i "sine=frequency=180:sample_rate=48000" \
  -f lavfi -i "anoisesrc=color=brown:amplitude=0.25:sample_rate=48000" \
  -filter_complex "[2]volume=0.08[h];[3]volume=0.03[h3];[4]lowpass=f=200,volume=1.2[r];[0][1][h][h3][r]amix=inputs=5:duration=first:normalize=0[a]" \
  -map "[a]" -ar 48000 noisy.wav
"$FF" -v error -y -loop 1 -framerate 30 -i person.jpg -i noisy.wav \
  -filter_complex "[0]scale=1600:-2,zoompan=z='1.05+0.04*sin(on/40)':x='iw/2-(iw/zoom/2)+40*sin(on/25)':y='ih/2-(ih/zoom/2)':d=1:s=1280x720:fps=30[v]" \
  -map "[v]" -map 1:a -shortest -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a aac -b:a 192k test_street.mp4
echo "fixtures in $OUT"
