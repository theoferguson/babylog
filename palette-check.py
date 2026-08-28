import math, itertools

def hex2rgb(h): h=h.lstrip('#'); return tuple(int(h[i:i+2],16)/255 for i in (0,2,4))
def rgb2hex(r): return '#%02X%02X%02X'%tuple(max(0,min(255,round(c*255))) for c in r)
def lin(c): return c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4
def unlin(c): return c*12.92 if c<=0.0031308 else 1.055*c**(1/2.4)-0.055

def rgb2lab(rgb):
    r,g,b=[lin(c) for c in rgb]
    X=(0.4124564*r+0.3575761*g+0.1804375*b)/0.95047
    Y=(0.2126729*r+0.7151522*g+0.0721750*b)/1.00000
    Z=(0.0193339*r+0.1191920*g+0.9503041*b)/1.08883
    f=lambda t: t**(1/3) if t>216/24389 else (841/108)*t+4/29
    fx,fy,fz=f(X),f(Y),f(Z)
    return (116*fy-16, 500*(fx-fy), 200*(fy-fz))

def de2000(l1,l2):
    L1,a1,b1=l1; L2,a2,b2=l2
    C1,C2=math.hypot(a1,b1),math.hypot(a2,b2); Cb=(C1+C2)/2
    G=0.5*(1-math.sqrt(Cb**7/(Cb**7+25**7))) if Cb>0 else 0
    a1p,a2p=(1+G)*a1,(1+G)*a2
    C1p,C2p=math.hypot(a1p,b1),math.hypot(a2p,b2)
    h1=math.degrees(math.atan2(b1,a1p))%360 if (a1p or b1) else 0
    h2=math.degrees(math.atan2(b2,a2p))%360 if (a2p or b2) else 0
    dLp=L2-L1; dCp=C2p-C1p
    if C1p*C2p==0: dhp=0
    elif abs(h2-h1)<=180: dhp=h2-h1
    elif h2-h1>180: dhp=h2-h1-360
    else: dhp=h2-h1+360
    dHp=2*math.sqrt(C1p*C2p)*math.sin(math.radians(dhp)/2)
    Lbp=(L1+L2)/2; Cbp=(C1p+C2p)/2
    if C1p*C2p==0: hbp=h1+h2
    elif abs(h1-h2)<=180: hbp=(h1+h2)/2
    elif h1+h2<360: hbp=(h1+h2+360)/2
    else: hbp=(h1+h2-360)/2
    T=(1-0.17*math.cos(math.radians(hbp-30))+0.24*math.cos(math.radians(2*hbp))
       +0.32*math.cos(math.radians(3*hbp+6))-0.20*math.cos(math.radians(4*hbp-63)))
    dth=30*math.exp(-(((hbp-275)/25)**2))
    Rc=2*math.sqrt(Cbp**7/(Cbp**7+25**7)) if Cbp>0 else 0
    Sl=1+(0.015*(Lbp-50)**2)/math.sqrt(20+(Lbp-50)**2)
    Sc=1+0.045*Cbp; Sh=1+0.015*Cbp*T
    Rt=-math.sin(math.radians(2*dth))*Rc
    return math.sqrt((dLp/Sl)**2+(dCp/Sc)**2+(dHp/Sh)**2+Rt*(dCp/Sc)*(dHp/Sh))

# Machado et al. 2009, severity 1.0, applied in linear RGB
CVD={'protanopia':  [[0.152286,1.052583,-0.204868],[0.114503,0.786281,0.099216],[-0.003882,-0.048116,1.051998]],
     'deuteranopia':[[0.367322,0.860646,-0.227968],[0.280085,0.672501,0.047413],[-0.011820,0.042940,0.968881]],
     'tritanopia':  [[1.255528,-0.076749,-0.178779],[-0.078411,0.930809,0.147602],[0.004733,0.691367,0.303900]]}
def sim(rgb,kind):
    m=CVD[kind]; r,g,b=[lin(c) for c in rgb]
    return tuple(unlin(max(0,min(1,row[0]*r+row[1]*g+row[2]*b))) for row in m)

def L(rgb): r,g,b=[lin(c) for c in rgb]; return 0.2126*r+0.7152*g+0.0722*b
def contrast(a,b):
    l1,l2=sorted([L(a),L(b)],reverse=True); return (l1+0.05)/(l2+0.05)
