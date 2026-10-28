sub Main(args as Dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    scene = screen.CreateScene("StreamTestScene")
    screen.Show()
    input = CreateObject("roInput")
    input.SetMessagePort(port)
    if args <> invalid then scene.runConfig = args
    while true
        message = Wait(0, port)
        if Type(message) = "roSGScreenEvent"
            if message.IsScreenClosed() then return
        else if Type(message) = "roInputEvent"
            if message.IsInput() then scene.runConfig = message.GetInfo()
        end if
    end while
end sub
