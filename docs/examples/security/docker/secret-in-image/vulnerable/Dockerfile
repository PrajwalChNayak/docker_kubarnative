# syntax=docker/dockerfile:1

# DELIBERATELY VULNERABLE. Build this only in a disposable lab.
# The credential is added in one layer and removed in a later layer. Removing
# a file does not rewrite the earlier layer that still contains it, so the
# secret survives in image history and in the layer tarball.
FROM alpine:3.22

WORKDIR /app

# The vulnerability: fake-credentials.env enters the image as its own layer.
COPY fake-credentials.env /app/fake-credentials.env

# "Cleaning up" here is theatre: this rm creates a new layer that hides the
# file from the running container's filesystem but leaves the COPY layer,
# which still holds the plaintext, fully intact in the image.
RUN . /app/fake-credentials.env \
 && printf 'built with key %s\n' "${#FAKE_API_KEY}" > /app/build-marker \
 && rm -f /app/fake-credentials.env

CMD ["sh"]
