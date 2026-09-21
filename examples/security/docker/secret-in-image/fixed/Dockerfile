# syntax=docker/dockerfile:1

# FIXED. The secret is provided by a build secret mount, not by COPY or ARG.
# It is bind-mounted onto a tmpfs for the duration of a single RUN and is
# never written to any layer, so nothing about it survives in the image.
FROM alpine:3.22

WORKDIR /app

# Build with:
#   docker build --secret id=api_key,src=./fake-credentials.env \
#     -f fixed/Dockerfile -t secret-fixed ..
# Inside the RUN the value is readable at /run/secrets/api_key and disappears
# when the step finishes. Only the derived, non-sensitive marker is committed.
RUN --mount=type=secret,id=api_key \
    API_KEY="$(cat /run/secrets/api_key)" \
 && printf 'built with a %s-char key\n' "${#API_KEY}" > /app/build-marker

CMD ["sh"]
