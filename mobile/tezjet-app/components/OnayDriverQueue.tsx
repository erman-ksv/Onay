import Text from "./OnayText";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { validateApiEndpoint } from "../lib/api";
import { parseOnayLaneQueue, type OnayLaneRow } from "../lib/onay-lane-queue";
import { onayPalette } from "./OnayScreenFrame";
import OnayIcon from "./OnayIcon";
export default function OnayDriverQueue({ endpoint, token, driverId, active, theme, onChoose }: { endpoint: string; token: string; driverId: string; active: boolean; theme: "light" | "dark"; onChoose: () => void }) {
 const [rows,setRows]=useState<OnayLaneRow[]|null>(null),[error,setError]=useState(""),[retry,setRetry]=useState(0);const c=onayPalette(theme);
 useEffect(() => {
  if (!active) return;
  let alive=true,pending=false;let controller:AbortController|null=null;
  async function load() {
   if (pending) return;pending=true;controller=new AbortController();const requestController=controller;
   const timeout=setTimeout(()=>requestController.abort(),15000);setRows(null);setError("");
   try {const response=await fetch(validateApiEndpoint(endpoint)+"/api/queue",{signal:requestController.signal,cache:"no-store",headers:{Authorization:"Bearer "+token}});if(!response.ok)throw new Error("Не удалось обновить очередь.");const next=parseOnayLaneQueue(await response.json());if(alive&&!requestController.signal.aborted)setRows(next);}
   catch {if(alive){setRows(null);setError("Нет актуальных данных очереди. Повтори обновление.");}}
   finally {clearTimeout(timeout);pending=false;}
  }
  void load();const timer=setInterval(()=>{void load();},10000);
  return()=>{alive=false;controller?.abort();clearInterval(timer);};
 },[endpoint,token,driverId,active,retry]);
 return <View testID="onay-driver-lane-list" style={{gap:12}}>
 <Pressable accessibilityRole="button" testID="onay-driver-route-editor-toggle" onPress={onChoose} style={{backgroundColor:c.card,padding:16,borderRadius:20,flexDirection:"row",alignItems:"center",gap:12}}><OnayIcon name="pin" color={c.accent}/><Text style={{color:c.text,fontSize:16,flex:1}}>Маршрут и направление</Text><OnayIcon name="chev" color={c.muted}/></Pressable>
 {rows===null&&!error?<ActivityIndicator color={c.accent}/>:null}
 {error?<Text accessibilityRole="alert" style={{color:c.danger}}>{error}</Text>:null}
 {rows?.length===0?<Text testID="onay-driver-queue-empty" style={{color:c.muted}}>В этой очереди пока нет водителей.</Text>:null}
 {rows?.slice(0,100).map(row=><View key={row.driverId} style={{backgroundColor:c.card,borderWidth:row.driverId===driverId?1:0,borderColor:c.accent,borderRadius:20,padding:16,flexDirection:"row",alignItems:"center",gap:12}}><Text style={{color:c.accent,fontSize:24,fontWeight:"700",width:32}}>{row.position}</Text><View style={{flex:1}}><Text style={{color:c.text,fontSize:17,fontWeight:"600"}}>{row.driverId===driverId?"Вы":"Водитель"}</Text><Text style={{color:c.muted,fontSize:14,marginTop:4}}>Свободных мест: {row.availableSeats}</Text></View><OnayIcon name="car" color={c.muted}/></View>)}
 {rows&&rows.length>100?<Text style={{color:c.muted}}>Показано 100 из {rows.length}</Text>:null}
 <Pressable accessibilityRole="button" testID="onay-driver-lane-refresh" onPress={()=>setRetry(value=>value+1)} style={{minHeight:48,justifyContent:"center",alignItems:"center",borderRadius:16,borderWidth:1,borderColor:c.border}}><Text style={{color:c.text,fontSize:15}}>Обновить очередь</Text></Pressable>
 </View>;
}
