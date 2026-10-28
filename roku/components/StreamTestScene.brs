sub init()
    m.video = m.top.FindNode("video")
    m.status = m.top.FindNode("status")
    m.sampler = m.top.FindNode("sampler")
    m.sampler.ObserveField("fire", "samplePlayback")
    m.video.ObserveField("state", "stateChanged")
    m.active = false
end sub

sub startRun()
    config = m.top.runConfig
    if config = invalid then return
    if config.stopRunId <> invalid
        if m.active and config.stopRunId = m.runId
            emitMetric({ event: "aborted" })
            m.active = false
            m.sampler.control = "stop"
            m.video.control = "stop"
        end if
        return
    end if
    if config.streamUrl = invalid or config.runId = invalid then return
    if config.protocol <> "hls" and config.protocol <> "dash" then return
    if Left(config.streamUrl, 7) <> "http://" and Left(config.streamUrl, 8) <> "https://" then return
    m.active = false
    m.sampler.control = "stop"
    m.video.control = "stop"
    m.runId = config.runId
    m.protocol = config.protocol
    m.stopAfterMs = 195000
    if config.stopAfterMs <> invalid then m.stopAfterMs = Val(config.stopAfterMs)
    m.clock = CreateObject("roTimespan")
    m.clock.Mark()
    content = CreateObject("roSGNode", "ContentNode")
    content.url = config.streamUrl
    content.streamFormat = config.protocol
    content.title = "HLS DASH Stream Tester"
    m.video.content = content
    m.video.notificationInterval = 0.25
    m.video.SetFocus(true)
    m.status.text = "Testing " + config.protocol + " - " + config.runId
    m.active = true
    emitMetric({ event: "start", protocol: config.protocol })
    m.sampler.control = "start"
    m.video.control = "play"
end sub

sub emitMetric(data as Object)
    if not m.active then return
    data["schemaVersion"] = 1
    data["runId"] = m.runId
    data["atMs"] = m.clock.TotalMilliseconds()
    print "SIM_METRIC " + FormatJson(data)
end sub

sub stateChanged()
    if not m.active then return
    data = { event: "state", state: m.video.state }
    if m.video.state = "error"
        data["errorCode"] = m.video.errorCode
        data["errorMessage"] = m.video.errorMsg
    end if
    emitMetric(data)
end sub

sub samplePlayback()
    if not m.active then return
    data = { event: "sample", state: m.video.state, position: m.video.position }
    info = m.video.positionInfo
    if info <> invalid
        encodePosition(data, "video", info.video)
        encodePosition(data, "audio", info.audio)
        data.epoch = info.epoch
    end if
    data.startup = m.video.playStartInfo
    data["videoFormat"] = m.video.videoFormat
    emitMetric(data)
    if m.clock.TotalMilliseconds() >= m.stopAfterMs
        emitMetric({ event: "complete" })
        m.active = false
        m.sampler.control = "stop"
        m.video.control = "stop"
    end if
end sub

' FormatJson rounds large floating point epoch values to six significant digits.
' Integer whole seconds plus small millisecond fractions retain useful precision.
sub encodePosition(data as Object, prefix as String, value as Dynamic)
    if value = invalid then return
    ' Fix() accepts a Float and loses precision at UTC epoch magnitudes.
    ' Convert the native Double directly to LongInteger instead.
    wholeSeconds& = value
    if value - wholeSeconds& < 0 then wholeSeconds& = wholeSeconds& - 1
    data[prefix + "WholeSeconds"] = wholeSeconds&
    data[prefix + "FractionMilliseconds"] = Int((value - wholeSeconds&) * 1000#)
end sub
